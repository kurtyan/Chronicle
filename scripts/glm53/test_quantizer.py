"""Tests for quantize_glm53_experts_w4a16.py (CPU only)."""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

import torch
from safetensors import safe_open
from safetensors.torch import save_file

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "quantize_glm53_experts_w4a16.py")
sys.path.insert(0, os.path.dirname(SCRIPT))
import quantize_glm53_experts_w4a16 as Q  # noqa: E402

torch.manual_seed(0)
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(f"[{'PASS' if cond else 'FAIL'}] {name} {detail}")


def fp8_block_quant(w):
    """DeepSeek/GLM style: W ~= W_fp8 * scale_inv, per 128x128 block."""
    o, i = w.shape
    bo, bi = (o + 127) // 128, (i + 127) // 128
    s = torch.zeros(bo, bi)
    q = torch.zeros_like(w)
    for a in range(bo):
        for b in range(bi):
            blk = w[a*128:(a+1)*128, b*128:(b+1)*128]
            sc = blk.abs().max().clamp_min(1e-12) / 448.0
            s[a, b] = sc
            q[a*128:(a+1)*128, b*128:(b+1)*128] = blk / sc
    return q.to(torch.float8_e4m3fn), s


def realistic_weight(o, i):
    # gaussian + sparse outliers, like trained MoE expert weights
    w = torch.randn(o, i) * 0.02
    mask = torch.rand(o, i) < 0.001
    w[mask] *= 8
    return w


# ---------------------------------------------------------------- 1. packing
q = torch.randint(-8, 8, (256, 512), dtype=torch.int8)
from compressed_tensors.compressors.pack_quantized.helpers import (  # noqa
    pack_to_int32, unpack_from_int32,
)
ours = Q.pack_int4(q)
ref = pack_to_int32(q, 4)
check("packing == compressed-tensors pack_to_int32", torch.equal(ours, ref.to(torch.int32)))
back = unpack_from_int32(ours, 4, torch.Size(q.shape))
check("compressed-tensors unpack_from_int32(ours) == original", torch.equal(back.to(torch.int8), q))

# ---------------------------------------------------------------- 2. library decompression
from compressed_tensors.quantization import QuantizationArgs, QuantizationScheme  # noqa
from compressed_tensors.compressors.pack_quantized.base import PackedQuantizationCompressor  # noqa


class _Comp:
    """Thin adapter: library decompression of one linear."""
    def decompress_weight(self, compressed_data, quantization_args):
        scheme = QuantizationScheme(targets=["Linear"], weights=quantization_args)
        sd = PackedQuantizationCompressor.decompress(dict(compressed_data), scheme)
        return sd["weight"]

w = realistic_weight(256, 512)
qq, s, rel = Q.quant_int4_group(w, 128, [1.0, 0.95, 0.9, 0.85, 0.8, 0.75])
args = QuantizationArgs(num_bits=4, type="int", symmetric=True, strategy="group", group_size=128)
comp = _Comp()
lib_deq = comp.decompress_weight(
    compressed_data={
        "weight_packed": Q.pack_int4(qq),
        "weight_scale": s,
        "weight_shape": torch.tensor(list(w.shape)),
    },
    quantization_args=args,
).float()
our_deq = (qq.view(256, 4, 128).float() * s.float().unsqueeze(-1)).view(256, 512)
diff = (lib_deq - our_deq).abs().max().item()
check("library decompression == our dequant", diff < 1e-2 * our_deq.abs().max().item(),
      f"(max abs diff {diff:.2e})")
lib_rel = ((lib_deq - w).norm() / w.norm()).item()
check("int4 g128 relative error is sane", 0.03 < lib_rel < 0.15, f"(rel err {lib_rel:.4f})")

_, _, rel_rtn = Q.quant_int4_group(w, 128, [1.0])
check("clip search beats plain RTN", rel < rel_rtn, f"({rel:.4f} vs RTN {rel_rtn:.4f})")

# ---------------------------------------------------------------- 3. FP8 block dequant
w = realistic_weight(300, 260)  # non-multiple of 128 to exercise edge blocks
w8, s8 = fp8_block_quant(w)
deq = Q.dequant_fp8_block(w8, s8)
fp8_rel = ((deq - w).norm() / w.norm()).item()
check("FP8 block dequant (incl. ragged edge blocks)", fp8_rel < 0.05, f"(rel err {fp8_rel:.4f})")

# ---------------------------------------------------------------- 4. end-to-end fake checkpoint
tmp = tempfile.mkdtemp(dir=os.path.dirname(os.path.abspath(__file__)))
src, dst = os.path.join(tmp, "src"), os.path.join(tmp, "dst")
os.makedirs(src)
H, I = 256, 128  # hidden, moe intermediate
P = "model.language_model.layers"
orig = {}  # original high-precision expert weights for error check

shard1, shard2 = {}, {}
for layer in (3, 45):  # a normal MoE layer and the MTP layer
    for e in range(3):
        for proj, shape in (("gate_proj", (I, H)), ("up_proj", (I, H)), ("down_proj", (H, I))):
            k = f"{P}.{layer}.mlp.experts.{e}.{proj}.weight"
            wt = realistic_weight(*shape)
            w8, s8 = fp8_block_quant(wt)
            orig[k] = Q.dequant_fp8_block(w8, s8)
            shard1[k] = w8
            # put one scale in the OTHER shard to test cross-shard lookup
            target = shard2 if (layer == 3 and e == 0 and proj == "down_proj") else shard1
            target[k[:-len("weight")] + "weight_scale_inv"] = s8
# shared expert + attention (FP8 non-expert linears)
for k, shape in ((f"{P}.3.mlp.shared_experts.gate_proj.weight", (I, H)),
                 (f"{P}.3.self_attn.kv_b_proj.weight", (H, H))):
    w8, s8 = fp8_block_quant(realistic_weight(*shape))
    shard2[k], shard2[k[:-len("weight")] + "weight_scale_inv"] = w8, s8
# BF16 / F32 tensors that must be copied verbatim
shard2[f"{P}.3.input_layernorm.weight"] = torch.ones(H, dtype=torch.bfloat16)
shard2[f"{P}.3.self_attn.indexer.wk.weight"] = torch.randn(64, H).to(torch.bfloat16)
shard2[f"{P}.3.mlp.gate.weight"] = torch.randn(3, H).to(torch.float32)
shard2["lm_head.weight"] = torch.randn(512, H).to(torch.bfloat16)

save_file(shard1, os.path.join(src, "model-00001-of-00002.safetensors"))
save_file(shard2, os.path.join(src, "model-00002-of-00002.safetensors"))
wm = {k: "model-00001-of-00002.safetensors" for k in shard1}
wm.update({k: "model-00002-of-00002.safetensors" for k in shard2})
json.dump({"metadata": {}, "weight_map": wm}, open(os.path.join(src, "model.safetensors.index.json"), "w"))
json.dump({"model_type": "glm5_next", "text_config": {"index_topk": 0},
           "quantization_config": {"quant_method": "fp8"}},
          open(os.path.join(src, "config.json"), "w"))
open(os.path.join(src, "tokenizer.json"), "w").write("{}")
open(os.path.join(src, "chat_template.jinja"), "w").write("x")

r = subprocess.run([sys.executable, SCRIPT, "--src", src, "--dst", dst, "--gpus", "cpu"],
                   capture_output=True, text=True)
print(r.stdout[-1500:])
if r.returncode != 0:
    print(r.stderr[-3000:])
check("script exits cleanly", r.returncode == 0)

if r.returncode == 0:
    idx = json.load(open(os.path.join(dst, "model.safetensors.index.json")))["weight_map"]
    out = {}
    for f in set(idx.values()):
        with safe_open(os.path.join(dst, f), "pt") as h:
            for k in h.keys():
                out[k] = h.get_tensor(k)
    check("index lists exactly the written tensors", set(idx) == set(out))
    check("no weight_scale_inv left", not any(k.endswith("weight_scale_inv") for k in out))
    check("no FP8 tensors left", all(t.dtype != torch.float8_e4m3fn for t in out.values()))

    errs = []
    ok = True
    for k, wt in orig.items():
        base = k[:-len(".weight")]
        p, sc, sh = out[base + ".weight_packed"], out[base + ".weight_scale"], out[base + ".weight_shape"]
        ok &= p.dtype == torch.int32 and p.shape == (wt.shape[0], wt.shape[1] // 8)
        ok &= sc.dtype == torch.bfloat16 and sc.shape == (wt.shape[0], wt.shape[1] // 128)
        ok &= sh.dtype == torch.int64 and sh.tolist() == list(wt.shape)
        ok &= (k not in out)
        d = comp.decompress_weight(
            compressed_data={"weight_packed": p, "weight_scale": sc, "weight_shape": sh},
            quantization_args=args).float()
        errs.append(((d - wt).norm() / wt.norm()).item())
    check("all 18 expert linears (incl. MTP layer 45) packed with correct names/dtypes/shapes", ok)
    check("cross-shard scale lookup worked", f"{P}.3.mlp.experts.0.down_proj.weight_packed" in out)
    check("library-decompressed experts match originals",
          max(errs) < 0.2, f"(rel err mean {sum(errs)/len(errs):.4f} max {max(errs):.4f})")

    for k in (f"{P}.3.mlp.shared_experts.gate_proj.weight", f"{P}.3.self_attn.kv_b_proj.weight"):
        check(f"non-expert FP8 -> BF16: {k.split('layers.')[1]}",
              out[k].dtype == torch.bfloat16 and k[:-6] + "weight_packed" not in out)
    check("BF16/F32 tensors copied bit-exact",
          all(torch.equal(out[k], shard2[k]) for k in (
              f"{P}.3.input_layernorm.weight", f"{P}.3.self_attn.indexer.wk.weight",
              f"{P}.3.mlp.gate.weight", "lm_head.weight")))

    cfg = json.load(open(os.path.join(dst, "config.json")))
    qc = cfg["quantization_config"]
    check("config: compressed-tensors, other fields preserved",
          qc["quant_method"] == "compressed-tensors" and cfg["text_config"]["index_topk"] == 0)
    check("tokenizer/template files copied",
          os.path.exists(os.path.join(dst, "tokenizer.json"))
          and os.path.exists(os.path.join(dst, "chat_template.jinja")))
    check("no leftover .done markers", not any(f.endswith(".done") for f in os.listdir(dst)))

    # config parses with the library's own model
    from compressed_tensors.quantization import QuantizationConfig  # noqa
    try:
        QuantizationConfig.model_validate(qc)
        check("quantization_config validates with compressed-tensors", True)
    except Exception as e:  # noqa
        check("quantization_config validates with compressed-tensors", False, str(e)[:300])

    # ignore regex, against vLLM-style module names
    pat = qc["ignore"][0][3:]
    should_ignore = ["language_model.model.layers.3.self_attn.kv_b_proj",
                     "language_model.model.layers.3.self_attn.qkv_proj",
                     "language_model.model.layers.3.mlp.shared_experts.gate_up_proj",
                     "language_model.model.layers.0.mlp.gate_up_proj",
                     "language_model.model.layers.0.mlp.down_proj",
                     "language_model.model.layers.45.eh_proj",
                     "language_model.lm_head", "visual.blocks.0.attn.qkv"]
    must_quant = ["language_model.model.layers.3.mlp.experts",
                  "language_model.model.layers.45.mlp.experts",
                  "model.language_model.layers.3.mlp.experts.7.gate_proj"]
    check("ignore regex skips all non-expert modules",
          all(re.match(pat, n) for n in should_ignore))
    check("ignore regex keeps routed experts quantized",
          not any(re.match(pat, n) for n in must_quant))

shutil.rmtree(tmp)
n_fail = sum(1 for _, ok in results if not ok)
print(f"\n{len(results) - n_fail}/{len(results)} passed")
sys.exit(1 if n_fail else 0)

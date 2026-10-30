#!/usr/bin/env python3
"""
Quantize GLM-5.3-Flash routed experts to W4A16 for vLLM on Ada (sm_89).

Output: a compressed-tensors "pack-quantized" checkpoint that vLLM serves with
Marlin W4A16 MoE kernels (supported on sm_80+, so L40S is fine).

  * Routed experts  (...mlp.experts.<E>.{gate,up,down}_proj.weight)
        FP8 block-128 -> BF16 -> int4 symmetric, group-wise, round-to-nearest
        with a per-group clipping search (cheap, no calibration data).
  * Every other FP8 linear (attention, KDA, shared experts, dense MLPs, MTP proj)
        dequantized to BF16 and left unquantized (~10B params, ~2-3 GiB/GPU at TP8).
  * All other tensors (BF16/F32 norms, embeddings, lm_head, vision, indexer, ...)
        copied unchanged.

Streams one shard at a time, so host RAM needs are small. Resumable.

Usage:
  python quantize_glm53_experts_w4a16.py \
      --src /data/models/GLM-5.3-Flash \
      --dst /data/models/GLM-5.3-Flash-W4A16-experts \
      --gpus 0,1,2,3,4,5,6,7
"""
import argparse
import json
import os
import re
import shutil
import time

import torch
import torch.multiprocessing as mp
from safetensors import safe_open
from safetensors.torch import save_file

EXPERT_RE = re.compile(r"\.mlp\.experts\.\d+\.(gate|up|down)_proj\.weight$")
FP8_BLOCK = 128
FP8_DTYPES = {torch.float8_e4m3fn}


# ----------------------------------------------------------------------------
# int4 packing (compressed-tensors pack-quantized layout)
#   q in [-8, 7]  ->  q + 8 as uint4, 8 values per int32 along the input dim,
#   element j of each 8-group in bits [4j, 4j+4).
# ----------------------------------------------------------------------------
def pack_int4(q: torch.Tensor) -> torch.Tensor:
    out_f, in_f = q.shape
    assert in_f % 8 == 0, f"input dim {in_f} not divisible by 8"
    u = ((q.to(torch.int32) + 8) & 0xF).view(out_f, in_f // 8, 8)
    packed = torch.zeros(out_f, in_f // 8, dtype=torch.int32, device=q.device)
    for j in range(8):
        packed |= u[:, :, j] << (4 * j)
    return packed


def unpack_int4(p: torch.Tensor, in_f: int) -> torch.Tensor:
    vals = [(p >> (4 * j)) & 0xF for j in range(8)]
    u = torch.stack(vals, dim=-1).view(p.shape[0], -1)[:, :in_f]
    return (u - 8).to(torch.int8)


def self_test():
    q = torch.randint(-8, 8, (64, 256), dtype=torch.int8)
    p = pack_int4(q)
    assert torch.equal(unpack_int4(p, 256), q), "pack/unpack round trip failed"
    pack_to_int32 = None
    for mod in (
        "compressed_tensors.compressors.pack_quantized.helpers",  # >= 0.20
        "compressed_tensors.compressors.quantized_compressors.pack_quantized",  # older
    ):
        try:
            pack_to_int32 = __import__(mod, fromlist=["pack_to_int32"]).pack_to_int32
            break
        except (ImportError, AttributeError):
            continue
    if pack_to_int32 is None:
        print("[self-test] compressed-tensors not found; round-trip check only")
        return
    ref = pack_to_int32(q, 4)
    assert torch.equal(ref.to(torch.int32), p), "packing differs from compressed-tensors"
    print("[self-test] packing matches compressed-tensors")


# ----------------------------------------------------------------------------
# math
# ----------------------------------------------------------------------------
def dequant_fp8_block(w: torch.Tensor, s: torch.Tensor) -> torch.Tensor:
    """DeepSeek-style block FP8: W = W_fp8 * scale_inv (per 128x128 block)."""
    w = w.float()
    s = s.float()
    s = s.repeat_interleave(FP8_BLOCK, 0)[: w.shape[0]]
    s = s.repeat_interleave(FP8_BLOCK, 1)[:, : w.shape[1]]
    return w * s


def quant_int4_group(w: torch.Tensor, group: int, ratios):
    """Symmetric int4, per-(row, group) scale, best clip ratio per group by MSE."""
    out_f, in_f = w.shape
    assert in_f % group == 0, f"input dim {in_f} not divisible by group {group}"
    g = w.view(out_f, in_f // group, group)
    absmax = g.abs().amax(dim=-1, keepdim=True).clamp_min(1e-8)

    best_err, best_s = None, None
    for r in ratios:
        s = absmax * r / 7.5
        q = torch.clamp(torch.round(g / s), -8, 7)
        err = ((q * s - g) ** 2).sum(dim=-1, keepdim=True)
        if best_err is None:
            best_err, best_s = err, s
        else:
            better = err < best_err
            best_err = torch.where(better, err, best_err)
            best_s = torch.where(better, s, best_s)

    # quantize with exactly the scale that will be stored (bf16)
    s = best_s.to(torch.bfloat16).float()
    q = torch.clamp(torch.round(g / s), -8, 7)
    rel_err = ((q * s - g).norm() / g.norm().clamp_min(1e-12)).item()
    return (
        q.to(torch.int8).view(out_f, in_f),
        s.squeeze(-1).to(torch.bfloat16).contiguous(),
        rel_err,
    )


# ----------------------------------------------------------------------------
# per-shard worker
# ----------------------------------------------------------------------------
class TensorSource:
    """Reads tensors from any shard (a weight's scale may live in another shard)."""

    def __init__(self, src, weight_map):
        self.src, self.weight_map, self.handles = src, weight_map, {}

    def get(self, key):
        fname = self.weight_map[key]
        if fname not in self.handles:
            self.handles[fname] = safe_open(os.path.join(self.src, fname), "pt", device="cpu")
        return self.handles[fname].get_tensor(key)

    def has(self, key):
        return key in self.weight_map


def process_shard(args):
    src, dst, fname, keys, weight_map, group, ratios, device = args
    out_path = os.path.join(dst, fname)
    done_marker = out_path + ".done"
    if os.path.exists(done_marker):
        with open(done_marker) as f:
            return json.load(f)

    if device == "cpu":
        dev = torch.device("cpu")
    else:
        torch.cuda.set_device(device)
        dev = torch.device(f"cuda:{device}")
    srcs = TensorSource(src, weight_map)
    out, errs = {}, []
    n_expert = n_deq = n_copy = 0
    t0 = time.time()

    for k in keys:
        if k.endswith(".weight_scale_inv"):
            continue  # consumed together with its weight
        t = srcs.get(k)
        scale_key = k[: -len("weight")] + "weight_scale_inv" if k.endswith(".weight") else None
        base = k[: -len(".weight")] if k.endswith(".weight") else None

        if base is not None and EXPERT_RE.search(k):
            w = t.to(dev)
            if t.dtype in FP8_DTYPES:
                if not srcs.has(scale_key):
                    raise RuntimeError(f"missing scale for FP8 tensor {k}")
                w = dequant_fp8_block(w, srcs.get(scale_key).to(dev))
            else:
                w = w.float()
            q, s, rel = quant_int4_group(w, group, ratios)
            out[base + ".weight_packed"] = pack_int4(q).cpu()
            out[base + ".weight_scale"] = s.cpu()
            out[base + ".weight_shape"] = torch.tensor(list(w.shape), dtype=torch.int64)
            errs.append(rel)
            n_expert += 1
        elif t.dtype in FP8_DTYPES:
            if scale_key is None or not srcs.has(scale_key):
                raise RuntimeError(f"FP8 tensor without block scale: {k}")
            w = dequant_fp8_block(t.to(dev), srcs.get(scale_key).to(dev))
            out[k] = w.to(torch.bfloat16).cpu()
            n_deq += 1
        else:
            out[k] = t
            n_copy += 1

    save_file(out, out_path, metadata={"format": "pt"})
    result = {
        "file": fname,
        "keys": sorted(out.keys()),
        "n_expert": n_expert,
        "n_dequant": n_deq,
        "n_copy": n_copy,
        "err_sum": float(sum(errs)),
        "err_max": float(max(errs)) if errs else 0.0,
    }
    with open(done_marker, "w") as f:
        json.dump(result, f)
    print(
        f"[gpu{device}] {fname}: experts={n_expert} dequant={n_deq} copied={n_copy} "
        f"rel_err(mean/max)={(sum(errs)/len(errs) if errs else 0):.4f}/{result['err_max']:.4f} "
        f"{time.time()-t0:.0f}s",
        flush=True,
    )
    return result


# ----------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------
def build_quant_config(group):
    return {
        "quant_method": "compressed-tensors",
        "format": "pack-quantized",
        "quantization_status": "compressed",
        "config_groups": {
            "group_0": {
                "targets": ["Linear"],
                "weights": {
                    "num_bits": 4,
                    "type": "int",
                    "symmetric": True,
                    "strategy": "group",
                    "group_size": group,
                    "dynamic": False,
                    "actorder": None,
                    "observer": "minmax",
                    "observer_kwargs": {},
                },
                "input_activations": None,
                "output_activations": None,
                "format": "pack-quantized",
            }
        },
        # Everything whose module name does not contain "mlp.experts" stays unquantized.
        # (shared experts are "mlp.shared_experts", so they are excluded too.)
        "ignore": [r"re:^(?!.*mlp\.experts).*$"],
        "kv_cache_scheme": None,
        "sparsity_config": {},
        "global_compression_ratio": None,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="official FP8 GLM-5.3-Flash directory")
    ap.add_argument("--dst", required=True, help="output directory")
    ap.add_argument("--group-size", type=int, default=128, choices=[32, 64, 128])
    ap.add_argument(
        "--gpus", default="0",
        help="comma-separated GPU ids for parallel shards, or 'cpu' (slow; for testing)",
    )
    ap.add_argument(
        "--clip-ratios",
        default="1.0,0.95,0.9,0.85,0.8,0.75",
        help="per-group clipping candidates (use '1.0' for plain RTN)",
    )
    args = ap.parse_args()

    self_test()
    ratios = [float(x) for x in args.clip_ratios.split(",")]
    if args.gpus.strip().lower() == "cpu":
        gpus = ["cpu"]
    else:
        gpus = [int(x) for x in args.gpus.split(",")]
    os.makedirs(args.dst, exist_ok=True)

    with open(os.path.join(args.src, "model.safetensors.index.json")) as f:
        weight_map = json.load(f)["weight_map"]

    shards = {}
    for k, fname in weight_map.items():
        shards.setdefault(fname, []).append(k)
    files = sorted(shards)
    print(f"{len(weight_map)} tensors in {len(files)} shards; GPUs {gpus}")

    tasks = [
        (args.src, args.dst, fname, shards[fname], weight_map, args.group_size, ratios,
         gpus[i % len(gpus)])
        for i, fname in enumerate(files)
    ]
    ctx = mp.get_context("spawn")
    with ctx.Pool(processes=len(gpus)) as pool:
        results = pool.map(process_shard, tasks, chunksize=1)

    # index
    new_map, total_expert, err_sum, err_max = {}, 0, 0.0, 0.0
    for r in results:
        for k in r["keys"]:
            new_map[k] = r["file"]
        total_expert += r["n_expert"]
        err_sum += r["err_sum"]
        err_max = max(err_max, r["err_max"])
    total_size = sum(os.path.getsize(os.path.join(args.dst, f)) for f in files)
    with open(os.path.join(args.dst, "model.safetensors.index.json"), "w") as f:
        json.dump({"metadata": {"total_size": total_size}, "weight_map": new_map}, f, indent=2)

    # config: swap the fp8 quantization_config for compressed-tensors
    with open(os.path.join(args.src, "config.json")) as f:
        cfg = json.load(f)
    cfg["quantization_config"] = build_quant_config(args.group_size)
    with open(os.path.join(args.dst, "config.json"), "w") as f:
        json.dump(cfg, f, indent=2)

    # tokenizer, chat template, generation/preprocessor configs, etc.
    for name in os.listdir(args.src):
        p = os.path.join(args.src, name)
        if (
            os.path.isfile(p)
            and not name.endswith(".safetensors")
            and name not in ("model.safetensors.index.json", "config.json")
        ):
            shutil.copy2(p, os.path.join(args.dst, name))

    for fname in files:
        marker = os.path.join(args.dst, fname + ".done")
        if os.path.exists(marker):
            os.remove(marker)

    print(
        f"\nDone. {total_expert} expert linears quantized; "
        f"rel. error mean={err_sum/max(total_expert,1):.4f} max={err_max:.4f}; "
        f"output {total_size/1e9:.1f} GB in {args.dst}"
    )
    print("Remember: re-apply your index_topk change to the new config.json if you edit it there.")


if __name__ == "__main__":
    main()

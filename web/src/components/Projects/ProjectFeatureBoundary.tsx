import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ProjectFeatureBoundaryProps {
  children: ReactNode
  resetKey?: unknown
  label?: string
  fallback?: ReactNode
}

/** A project rendering failure must not unmount an existing task, note, or timer. */
export class ProjectFeatureBoundary extends Component<ProjectFeatureBoundaryProps, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() { return { failed: true } }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Project view failed; isolated from the workspace.', error, info.componentStack)
  }

  componentDidUpdate(previous: ProjectFeatureBoundaryProps) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false })
  }

  render() {
    if (!this.state.failed) return this.props.children
    if (this.props.fallback !== undefined) return this.props.fallback
    return <div role="alert" data-testid="project-feature-error" className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      {this.props.label || '项目信息'}暂时不可用。
      <button type="button" className="ml-2 underline" onClick={() => this.setState({ failed: false })}>重试</button>
    </div>
  }
}

export interface FleetReconcilePlaybookArgsOptions {
  concurrency: number
  manifestPath: string
  configOutDir: string
  executionImageTag: string
}

export function buildFleetReconcilePlaybookArgs(options: FleetReconcilePlaybookArgsOptions): string[] {
  return [
    'ansible/playbooks/fleet-reconcile.yml',
    '-e',
    `reconcile_concurrency=${options.concurrency.toString()}`,
    '-e',
    `@${options.manifestPath}`,
    '-e',
    `config_dir=${options.configOutDir}`,
    '-e',
    `execution_image_tag=${options.executionImageTag}`,
  ]
}

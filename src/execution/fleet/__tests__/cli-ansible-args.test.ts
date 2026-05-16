import { describe, expect, it } from 'vitest'

import { buildFleetReconcilePlaybookArgs } from '../cli/ansible-args.js'

describe('buildFleetReconcilePlaybookArgs', () => {
  it('passes execution_image_tag to Ansible for staged config validation and systemd image pinning', () => {
    const args = buildFleetReconcilePlaybookArgs({
      concurrency: 5,
      manifestPath: 'config/.fleet-tmp/reconcile-manifest.json',
      configOutDir: 'config',
      executionImageTag: 'abc1234',
    })

    expect(args).toContain('execution_image_tag=abc1234')
  })
})

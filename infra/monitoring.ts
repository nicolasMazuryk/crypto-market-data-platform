import { clickhouseInstance } from './clickhouse'
import { requireEnv } from './workers/shared'
import { cluster } from './cluster'
import { fundingRates, fundingRatesLogGroupName } from './workers/funding-rates'
import { marketSync, marketSyncLogGroupName } from './workers/market-sync'
import { migrationLogGroupName, migrationRunner } from './workers/migration-runner'

export const alertChannel = new aws.sns.Topic('AlertChannel', {
  name: $interpolate`${$app.name}-${$app.stage}-alerts`,
})

export const slackNotifier = new sst.aws.Function('SlackNotifier', {
  handler: 'infra/slack-notifier/index.handler',
  runtime: 'nodejs22.x',
  timeout: '30 seconds',
  environment: {
    SLACK_WEBHOOK_URL: requireEnv('SLACK_WEBHOOK_URL'),
  },
  logging: {
    retention: '1 month',
  },
})

new aws.lambda.Permission('AlertChannelInvokePermission', {
  action: 'lambda:InvokeFunction',
  function: slackNotifier.name,
  principal: 'sns.amazonaws.com',
  sourceArn: alertChannel.arn,
})

new aws.sns.TopicSubscription('AlertChannelSlackSubscription', {
  topic: alertChannel.arn,
  protocol: 'lambda',
  endpoint: slackNotifier.arn,
})

const alarmActions = [alertChannel.arn]

export const clickHouseCpuAlarm = new aws.cloudwatch.MetricAlarm(
  'ClickHouseCpuAlarm',
  {
    alarmDescription: 'ClickHouse CPU above 80%',
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    metricName: 'CPUUtilization',
    namespace: 'AWS/EC2',
    period: 300,
    statistic: 'Average',
    threshold: 80,
    dimensions: {
      InstanceId: clickhouseInstance.id,
    },
    treatMissingData: 'notBreaching',
    alarmActions,
    okActions: alarmActions,
  }
)

export const clickHouseMemoryAlarm = new aws.cloudwatch.MetricAlarm(
  'ClickHouseMemoryAlarm',
  {
    alarmDescription: 'ClickHouse memory above 80%',
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    metricName: 'mem_used_percent',
    namespace: 'CWAgent',
    period: 300,
    statistic: 'Average',
    threshold: 80,
    dimensions: {
      InstanceId: clickhouseInstance.id,
    },
    treatMissingData: 'notBreaching',
    alarmActions,
    okActions: alarmActions,
  }
)

export const clickHouseDiskAlarm = new aws.cloudwatch.MetricAlarm(
  'ClickHouseDiskAlarm',
  {
    alarmDescription: 'ClickHouse /data disk usage above 80%',
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    metricName: 'disk_used_percent',
    namespace: 'CWAgent',
    period: 300,
    statistic: 'Average',
    threshold: 80,
    dimensions: {
      InstanceId: clickhouseInstance.id,
      path: '/data',
    },
    treatMissingData: 'notBreaching',
    alarmActions,
    okActions: alarmActions,
  }
)

export const clickHouseStatusAlarm = new aws.cloudwatch.MetricAlarm(
  'ClickHouseStatusAlarm',
  {
    alarmDescription: 'ClickHouse EC2 instance status checks failed',
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    metricName: 'StatusCheckFailed',
    namespace: 'AWS/EC2',
    period: 60,
    statistic: 'Maximum',
    threshold: 0,
    dimensions: {
      InstanceId: clickhouseInstance.id,
    },
    treatMissingData: 'notBreaching',
    alarmActions,
    okActions: alarmActions,
  }
)

export const workerCpuAlarm = new aws.cloudwatch.MetricAlarm('WorkerCpuAlarm', {
  alarmDescription: 'ECS worker cluster CPU above 80%',
  comparisonOperator: 'GreaterThanThreshold',
  evaluationPeriods: 1,
  metricName: 'CPUUtilization',
  namespace: 'AWS/ECS',
  period: 300,
  statistic: 'Average',
  threshold: 80,
  dimensions: {
    ClusterName: cluster.nodes.cluster.name,
  },
  treatMissingData: 'notBreaching',
  alarmActions,
  okActions: alarmActions,
})

export const workerMemoryAlarm = new aws.cloudwatch.MetricAlarm(
  'WorkerMemoryAlarm',
  {
    alarmDescription: 'ECS worker cluster memory above 80%',
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    metricName: 'MemoryUtilization',
    namespace: 'AWS/ECS',
    period: 300,
    statistic: 'Average',
    threshold: 80,
    dimensions: {
      ClusterName: cluster.nodes.cluster.name,
    },
    treatMissingData: 'notBreaching',
    alarmActions,
    okActions: alarmActions,
  }
)

const regionName = aws.getRegionOutput().name
const accountId = aws.getCallerIdentityOutput().accountId
const logsPrincipal = $interpolate`logs.${regionName}.amazonaws.com`

function createWorkerErrorForwarder(
  name: string,
  logGroupName: $util.Input<string>,
  dependency: $util.Resource
) {
  const sourceArn = $interpolate`arn:aws:logs:${regionName}:${accountId}:log-group:${logGroupName}:*`

  const permission = new aws.lambda.Permission(`${name}InvokePermission`, {
    action: 'lambda:InvokeFunction',
    function: slackNotifier.name,
    principal: logsPrincipal,
    sourceArn,
  })

  return new aws.cloudwatch.LogSubscriptionFilter(
    `${name}WorkerErrorAlarm`,
    {
      name: `${name.toLowerCase()}-errors`,
      logGroup: logGroupName,
      filterPattern: 'ERROR',
      destinationArn: slackNotifier.arn,
    },
    {
      dependsOn: [permission, dependency],
    }
  )
}

createWorkerErrorForwarder(
  'MarketSync',
  marketSyncLogGroupName,
  marketSync.nodes.taskDefinition
)
createWorkerErrorForwarder(
  'FundingRates',
  fundingRatesLogGroupName,
  fundingRates.nodes.taskDefinition
)
createWorkerErrorForwarder(
  'MigrationRunner',
  migrationLogGroupName,
  migrationRunner.nodes.taskDefinition
)

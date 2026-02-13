import { readFileSync } from 'node:fs'
import path from 'node:path'

import { vpc } from './network'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value
}

const clickhouseInstanceType = requireEnv('CLICKHOUSE_INSTANCE_TYPE')
const clickhouseVolumeSizeGb = Number.parseInt(
  requireEnv('CLICKHOUSE_VOLUME_SIZE_GB'),
  10
)
const clickhouseAllowedCidr = requireEnv('CLICKHOUSE_ALLOWED_CIDR')

if (Number.isNaN(clickhouseVolumeSizeGb) || clickhouseVolumeSizeGb < 20) {
  throw new Error(
    'CLICKHOUSE_VOLUME_SIZE_GB must be an integer greater than or equal to 20'
  )
}

const clickhousePassword = requireEnv('CLICKHOUSE_PASSWORD')
const clickhousePasswordBase64 = Buffer.from(clickhousePassword, 'utf8').toString(
  'base64'
)

const userDataTemplate = readFileSync(
  path.resolve(process.cwd(), 'docker/clickhouse/user-data.sh'),
  'utf8'
)
const userData = userDataTemplate.replace(
  '__CLICKHOUSE_PASSWORD_B64__',
  clickhousePasswordBase64
)

const publicSubnetId = vpc.publicSubnets.apply((subnets) => {
  const subnetId = subnets[0]
  if (!subnetId) {
    throw new Error('PipelineNetwork must include at least one public subnet')
  }

  return subnetId
})

const publicSubnet = aws.ec2.getSubnetOutput({ id: publicSubnetId })

const clickhouseAmi = aws.ssm.getParameterOutput({
  name: '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64',
})

const clickhouseRole = new aws.iam.Role('ClickHouseInstanceRole', {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: 'ec2.amazonaws.com',
  }),
})

new aws.iam.RolePolicyAttachment('ClickHouseCloudWatchPolicy', {
  role: clickhouseRole.name,
  policyArn: 'arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy',
})

new aws.iam.RolePolicyAttachment('ClickHouseSsmPolicy', {
  role: clickhouseRole.name,
  policyArn: 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
})

const clickhouseInstanceProfile = new aws.iam.InstanceProfile(
  'ClickHouseInstanceProfile',
  {
    role: clickhouseRole.name,
  }
)

export const clickhouseSecurityGroup = new aws.ec2.SecurityGroup(
  'ClickHouseAccess',
  {
    vpcId: vpc.id,
    description: 'ClickHouse ingress for workers (VPC) and operator access (CIDR)',
    ingress: [
      {
        protocol: 'tcp',
        fromPort: 8123,
        toPort: 8123,
        cidrBlocks: [vpc.nodes.vpc.cidrBlock],
        description: 'Allow worker HTTP traffic from within VPC',
      },
      {
        protocol: 'tcp',
        fromPort: 9000,
        toPort: 9000,
        cidrBlocks: [vpc.nodes.vpc.cidrBlock],
        description: 'Allow worker native ClickHouse traffic from within VPC',
      },
      {
        protocol: 'tcp',
        fromPort: 8123,
        toPort: 8123,
        cidrBlocks: [clickhouseAllowedCidr],
        description: 'Allow external HTTP access for DBeaver/DataGrip',
      },
      {
        protocol: 'tcp',
        fromPort: 9000,
        toPort: 9000,
        cidrBlocks: [clickhouseAllowedCidr],
        description: 'Allow external native ClickHouse access',
      },
    ],
    egress: [
      {
        protocol: '-1',
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ['0.0.0.0/0'],
      },
    ],
  }
)

export const clickhouseVolume = new aws.ebs.Volume('ClickHouseVolume', {
  availabilityZone: publicSubnet.availabilityZone,
  size: clickhouseVolumeSizeGb,
  type: 'gp3',
  tags: {
    Name: $interpolate`${$app.name}-${$app.stage}-clickhouse-volume`,
  },
})

export const clickhouseInstance = new aws.ec2.Instance('ClickHouseServer', {
  ami: clickhouseAmi.value,
  instanceType: clickhouseInstanceType,
  subnetId: publicSubnetId,
  vpcSecurityGroupIds: [clickhouseSecurityGroup.id],
  associatePublicIpAddress: true,
  iamInstanceProfile: clickhouseInstanceProfile.name,
  userData,
  rootBlockDevice: {
    volumeType: 'gp3',
    volumeSize: 20,
  },
  metadataOptions: {
    httpEndpoint: 'enabled',
    httpTokens: 'required',
  },
  tags: {
    Name: $interpolate`${$app.name}-${$app.stage}-clickhouse`,
  },
}, {
  deleteBeforeReplace: true,
})

new aws.ec2.VolumeAttachment('ClickHouseVolumeAttachment', {
  deviceName: '/dev/xvdf',
  volumeId: clickhouseVolume.id,
  instanceId: clickhouseInstance.id,
  stopInstanceBeforeDetaching: true,
}, {
  deleteBeforeReplace: true,
})

export const clickhouseIp = new aws.ec2.Eip('ClickHouseIp', {
  domain: 'vpc',
})

new aws.ec2.EipAssociation('ClickHouseIpAssociation', {
  allocationId: clickhouseIp.id,
  instanceId: clickhouseInstance.id,
})

export const clickhouseHost = clickhouseInstance.privateIp
export const clickhousePublicIp = clickhouseIp.publicIp

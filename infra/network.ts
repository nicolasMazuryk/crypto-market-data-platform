export const vpc = new sst.aws.Vpc('PipelineNetwork', {
  nat: 'ec2',
})

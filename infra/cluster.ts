import { vpc } from './network'

export const cluster = new sst.aws.Cluster('WorkerCluster', {
  vpc: {
    id: vpc.id,
    securityGroups: vpc.securityGroups,
    containerSubnets: vpc.privateSubnets,
    loadBalancerSubnets: vpc.publicSubnets,
    cloudmapNamespaceId: vpc.nodes.cloudmapNamespace.id,
    cloudmapNamespaceName: vpc.nodes.cloudmapNamespace.name,
  },
})

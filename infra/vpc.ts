// VPC: two AZs, no NAT gateway, no bastion. Fargate tasks and the ALB sit in
// the public subnets (SST default); Aurora sits in the private subnets.
export function createVpc() {
  return new sst.aws.Vpc("Vpc", { az: 2 });
}

export function getVpc(vpcId: string) {
  return sst.aws.Vpc.get("Vpc", vpcId);
}

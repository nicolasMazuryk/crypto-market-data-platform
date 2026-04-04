resource "hcloud_ssh_key" "nicolas" {
  name       = "nicolas"
  public_key = var.ssh_public_key
}

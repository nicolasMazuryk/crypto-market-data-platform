resource "hcloud_server" "main" {
  name        = "arbinet"
  server_type = var.server_type
  image       = var.image
  location    = var.location

  ssh_keys = [hcloud_ssh_key.nicolas.id]

  firewall_ids = [hcloud_firewall.main.id]

  user_data = templatefile("${path.module}/cloud-init.yml.tpl", {
    ssh_public_key = var.ssh_public_key
  })

  depends_on = [hcloud_network_subnet.main]

  # Hetzner API does not return ssh_keys or user_data after creation;
  # ignore to prevent forced server replacement on every plan.
  lifecycle {
    ignore_changes = [ssh_keys, user_data]
  }
}

resource "hcloud_server" "main" {
  name        = "arbinet"
  server_type = var.server_type
  image       = var.image
  location    = var.location

  ssh_keys = [hcloud_ssh_key.nicolas.id]

  firewall_ids = [hcloud_firewall.main.id]

  network {
    network_id = hcloud_network.main.id
  }

  user_data = templatefile("${path.module}/cloud-init.yml.tpl", {
    ssh_public_key = var.ssh_public_key
  })

  depends_on = [hcloud_network_subnet.main]
}

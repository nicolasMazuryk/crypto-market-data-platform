resource "hcloud_network" "main" {
  name     = "arbinet"
  ip_range = "10.0.0.0/16"
}

resource "hcloud_network_subnet" "main" {
  network_id   = hcloud_network.main.id
  type         = "cloud"
  network_zone = "eu-central"
  ip_range     = "10.0.1.0/24"
}

resource "hcloud_server_network" "main" {
  server_id  = hcloud_server.main.id
  network_id = hcloud_network.main.id
}

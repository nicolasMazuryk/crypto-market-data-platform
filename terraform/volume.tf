resource "hcloud_volume" "data" {
  name     = "arbinet-data-50"
  size     = var.volume_size
  location = var.location
  format   = "ext4"
}

resource "hcloud_volume_attachment" "data" {
  volume_id = hcloud_volume.data.id
  server_id = hcloud_server.main.id
  automount = false
}

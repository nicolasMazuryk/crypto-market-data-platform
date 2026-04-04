output "server_ip" {
  description = "Public IPv4 address of the server"
  value       = hcloud_server.main.ipv4_address
}

output "volume_linux_device" {
  description = "Linux device path of the attached volume"
  value       = hcloud_volume.data.linux_device
}

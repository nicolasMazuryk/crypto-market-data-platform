#cloud-config
package_update: true
package_upgrade: true

timezone: Europe/Warsaw

users:
  - name: nicolas
    groups: [sudo]
    sudo: ['ALL=(ALL) NOPASSWD:ALL']
    shell: /bin/bash
    ssh_authorized_keys:
      - "${ssh_public_key}"

# Lock down SSH
write_files:
  - path: /etc/ssh/sshd_config.d/ssh-hardening.conf
    permissions: "0644"
    content: |
      PermitRootLogin no
      PasswordAuthentication no
      KbdInteractiveAuthentication no
      ChallengeResponseAuthentication no
      X11Forwarding no
      AllowAgentForwarding no
      MaxAuthTries 5
      PubkeyAuthentication yes
      AllowTcpForwarding yes
      AllowUsers nicolas

  - path: /etc/fail2ban/jail.local
    permissions: "0644"
    content: |
      [sshd]
      enabled = true
      port = 22
      banaction = nftables-multiport
      maxretry = 5
      findtime = 10m
      bantime = 1h

packages:
  - unattended-upgrades
  - fail2ban
  - curl

runcmd:
  - [sh, -lc, "DEBIAN_FRONTEND=noninteractive dpkg-reconfigure -f noninteractive unattended-upgrades"]
  - [systemctl, restart, ssh]
  - [systemctl, enable, --now, fail2ban]

final_message: "cloud-init finished after $UPTIME seconds"

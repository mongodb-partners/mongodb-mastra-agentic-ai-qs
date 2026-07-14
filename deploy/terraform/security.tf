resource "aws_security_group" "app" {
  name        = "${var.name_prefix}-app-sg"
  description = "Marshal console: all traffic from the office/VPN ranges + admin SSH, egress all."
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name_prefix}-app-sg" }

  # Office/VPN ranges get all traffic (reaches nginx :80 and, for admin, the app :8000).
  # One all-protocol rule per CIDR keeps us well under AWS's 60-rule/SG limit even with a
  # long office list. These are trusted corporate ranges; nothing here is world-open.
  ingress {
    description = "All traffic from office/VPN ranges"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = var.office_cidrs
  }

  # The deploy machine keeps SSH regardless of the office list.
  ingress {
    description = "SSH (deploy machine)"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }

  # Egress all: SSM, KMS, git clone, docker pulls, the LLM gateway, Voyage, and Atlas SRV DNS.
  egress {
    description = "All egress"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

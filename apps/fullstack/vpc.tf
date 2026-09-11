locals {
  redes = {
    a = {
      az      = data.aws_availability_zones.disponiveis.names[0]
      publica = "10.0.0.0/24"
      privada = "10.0.10.0/24"
    }
    b = {
      az      = data.aws_availability_zones.disponiveis.names[1]
      publica = "10.0.1.0/24"
      privada = "10.0.11.0/24"
    }
  }
}

resource "aws_vpc" "principal" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "${var.deployment_namespace}-vpc"
  }
}

resource "aws_internet_gateway" "principal" {
  vpc_id = aws_vpc.principal.id

  tags = {
    Name = "${var.deployment_namespace}-igw"
  }
}

resource "aws_subnet" "publica" {
  for_each = local.redes

  vpc_id                  = aws_vpc.principal.id
  availability_zone       = each.value.az
  cidr_block              = each.value.publica
  map_public_ip_on_launch = true

  tags = {
    Name   = "${var.deployment_namespace}-public-${each.key}"
    Camada = "publica"
  }
}

resource "aws_subnet" "privada" {
  for_each = local.redes

  vpc_id                  = aws_vpc.principal.id
  availability_zone       = each.value.az
  cidr_block              = each.value.privada
  map_public_ip_on_launch = false

  tags = {
    Name   = "${var.deployment_namespace}-private-${each.key}"
    Camada = "privada"
  }
}

resource "aws_route_table" "publica" {
  vpc_id = aws_vpc.principal.id

  tags = {
    Name = "${var.deployment_namespace}-public-rt"
  }
}

resource "aws_route" "publica_internet" {
  route_table_id         = aws_route_table.publica.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.principal.id
}

resource "aws_route_table_association" "publica" {
  for_each = aws_subnet.publica

  subnet_id      = each.value.id
  route_table_id = aws_route_table.publica.id
}

resource "aws_eip" "nat" {
  domain = "vpc"

  depends_on = [aws_internet_gateway.principal]

  tags = {
    Name = "${var.deployment_namespace}-nat-eip"
  }
}

resource "aws_nat_gateway" "principal" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.publica["a"].id

  depends_on = [aws_route.publica_internet]

  tags = {
    Name = "${var.deployment_namespace}-nat"
  }
}

resource "aws_route_table" "privada" {
  vpc_id = aws_vpc.principal.id

  tags = {
    Name = "${var.deployment_namespace}-private-rt"
  }
}

resource "aws_route" "privada_internet" {
  route_table_id         = aws_route_table.privada.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.principal.id
}

resource "aws_route_table_association" "privada" {
  for_each = aws_subnet.privada

  subnet_id      = each.value.id
  route_table_id = aws_route_table.privada.id
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.principal.id
  service_name      = "com.amazonaws.${var.regiao}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.privada.id]

  tags = {
    Name = "${var.deployment_namespace}-s3-endpoint"
  }
}

resource "aws_vpc_endpoint" "dynamodb" {
  vpc_id            = aws_vpc.principal.id
  service_name      = "com.amazonaws.${var.regiao}.dynamodb"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.privada.id]

  tags = {
    Name = "${var.deployment_namespace}-dynamodb-endpoint"
  }
}

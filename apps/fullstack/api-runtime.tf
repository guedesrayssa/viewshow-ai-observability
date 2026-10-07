// Segredos de aplicação, publicados como Kubernetes Secrets no deploy.
resource "random_password" "auth_cookie_secret" {
  length  = 64
  special = false
}

resource "random_password" "cursor_secret" {
  length  = 64
  special = false
}


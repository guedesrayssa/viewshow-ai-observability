import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ACCOUNT_PROFILE } from "@/lib/settings-data";

export function ProfileCard() {
  const profile = ACCOUNT_PROFILE;

  return (
    <Card accent="brand" accentPosition="top">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="flex items-start gap-4">
          <Avatar size="lg" />
          <div>
            <p className="text-title text-ink">{profile.name}</p>
            <a
              href={`mailto:${profile.email}`}
              className="text-body-sm text-brand-blue hover:underline"
            >
              {profile.email}
            </a>
            <p className="text-body-sm text-ink-muted">{profile.role}</p>
            <Button variant="outline" size="sm" className="mt-3">
              Alterar foto
            </Button>
          </div>
        </div>

        <div className="flex flex-col items-start gap-3 sm:items-end">
          <Badge tone="success" withDot>
            Conta corporativa ativa
          </Badge>
          <div className="flex gap-8 text-right">
            <div>
              <p className="text-caption text-ink-subtle">Autenticação</p>
              <p className="text-body-sm font-medium text-ink">
                {profile.authMethod}
              </p>
            </div>
            <div>
              <p className="text-caption text-ink-subtle">Último acesso</p>
              <p className="text-body-sm font-medium text-ink">
                {profile.lastAccess}
              </p>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

"use client";

import { useState } from "react";
import { Card, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { NOTIFICATION_PREFERENCES } from "@/lib/settings-data";

export function NotificationsCard() {
  const [enabled, setEnabled] = useState(
    () => new Set(NOTIFICATION_PREFERENCES.map((preference) => preference.id)),
  );

  function toggle(id: string, checked: boolean) {
    setEnabled((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  return (
    <Card className="flex flex-1 flex-col">
      <CardTitle>Notificações</CardTitle>

      <div className="mt-4 divide-y divide-line">
        {NOTIFICATION_PREFERENCES.map((preference) => (
          <div
            key={preference.id}
            className="flex items-center justify-between gap-4 py-4"
          >
            <div>
              <p className="text-body-sm font-semibold text-ink">
                {preference.title}
              </p>
              <p className="text-caption text-ink-brand">
                {preference.description}
              </p>
            </div>
            <Switch
              label={preference.title}
              checked={enabled.has(preference.id)}
              onCheckedChange={(checked) => toggle(preference.id, checked)}
            />
          </div>
        ))}
      </div>
    </Card>
  );
}

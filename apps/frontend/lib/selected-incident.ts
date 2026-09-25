"use client";

import { useEffect, useSyncExternalStore } from "react";

import { createPersistedPreference } from "@/lib/persisted-preference";

const selectedIncident = createPersistedPreference<string>(
  "view-show:selected-incident",
  "",
  (value): value is string => value.trim().length > 0,
);

/** A URL tem prioridade; a última escolha continua disponível entre telas. */
export function useSelectedIncidentId(requestedId = "") {
  const storedId = useSyncExternalStore(
    selectedIncident.subscribe,
    selectedIncident.getSnapshot,
    selectedIncident.getServerSnapshot,
  );

  useEffect(() => {
    if (requestedId && requestedId !== storedId) selectedIncident.set(requestedId);
  }, [requestedId, storedId]);

  return requestedId || storedId;
}

export function selectIncident(id: string) {
  if (id) selectedIncident.set(id);
}

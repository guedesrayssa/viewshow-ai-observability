"use client";

import { useState } from "react";
import { SearchInput } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  APP_VERSION_OPTIONS,
  DEVICE_OPTIONS,
  REGION_OPTIONS,
  TIME_RANGE_OPTIONS,
} from "@/lib/dashboard-data";

export function FilterBar() {
  const [search, setSearch] = useState("");
  const [timeRange, setTimeRange] = useState(TIME_RANGE_OPTIONS[1].value);
  const [device, setDevice] = useState(DEVICE_OPTIONS[0].value);
  const [region, setRegion] = useState(REGION_OPTIONS[1].value);
  const [appVersion, setAppVersion] = useState(APP_VERSION_OPTIONS[0].value);

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap lg:flex-nowrap">
      <SearchInput
        placeholder="Buscar"
        aria-label="Buscar"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <Select
        aria-label="Período"
        value={timeRange}
        onChange={(event) => setTimeRange(event.target.value)}
      >
        {TIME_RANGE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
      <Select
        aria-label="Dispositivo"
        value={device}
        onChange={(event) => setDevice(event.target.value)}
      >
        {DEVICE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
      <Select
        aria-label="Região"
        value={region}
        onChange={(event) => setRegion(event.target.value)}
      >
        {REGION_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
      <Select
        aria-label="Versão do app"
        value={appVersion}
        onChange={(event) => setAppVersion(event.target.value)}
      >
        {APP_VERSION_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

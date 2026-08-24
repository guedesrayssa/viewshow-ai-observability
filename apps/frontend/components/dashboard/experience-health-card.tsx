"use client";

import { useState } from "react";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { getPointXPercent, LineChart } from "@/components/dashboard/line-chart";
import {
  EXPERIENCE_HEALTH_ANOMALY_RANGE,
  EXPERIENCE_HEALTH_BASELINE,
  EXPERIENCE_HEALTH_PEAK_INDEX,
  EXPERIENCE_HEALTH_SERIES,
  TIME_RANGE_OPTIONS,
} from "@/lib/dashboard-data";

export function ExperienceHealthCard() {
  const [timeRange, setTimeRange] = useState(TIME_RANGE_OPTIONS[1].value);
  const peakValue = EXPERIENCE_HEALTH_SERIES[EXPERIENCE_HEALTH_PEAK_INDEX].value;
  const anomalyCaptionLeft = getPointXPercent(
    EXPERIENCE_HEALTH_PEAK_INDEX,
    EXPERIENCE_HEALTH_SERIES.length,
  );

  return (
    <Card accent="brand" accentPosition="top" className="flex-1">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Saúde da experiência</CardTitle>
          <CardDescription>
            Série principal comparada à linha de base
          </CardDescription>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-body-sm font-medium text-critical-strong">
            {peakValue} erros/min · +18%
          </span>
          <Select
            aria-label="Período do gráfico"
            value={timeRange}
            onChange={(event) => setTimeRange(event.target.value)}
          >
            {TIME_RANGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="relative mt-4 h-72">
        <LineChart
          id="experience-health"
          data={EXPERIENCE_HEALTH_SERIES}
          max={400}
          yTicks={[0, 100, 250, 400]}
          baseline={EXPERIENCE_HEALTH_BASELINE}
          highlightRange={EXPERIENCE_HEALTH_ANOMALY_RANGE}
          peakIndex={EXPERIENCE_HEALTH_PEAK_INDEX}
          peakLabel={`${peakValue}/min`}
          xTickEvery={2}
        />
        <span
          className="absolute bottom-1 -translate-x-1/2 text-[11px] font-medium whitespace-nowrap text-critical-strong"
          style={{ left: `${anomalyCaptionLeft}%` }}
        >
          janela anômala
        </span>
      </div>
    </Card>
  );
}

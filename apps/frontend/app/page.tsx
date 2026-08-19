import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatCard } from "@/components/dashboard/stat-card";
import { FilterBar } from "@/components/dashboard/filter-bar";
import { ExperienceHealthCard } from "@/components/dashboard/experience-health-card";
import { IncidentsCard } from "@/components/dashboard/incidents-card";
import { STATS } from "@/lib/dashboard-data";

export default function Home() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Visão Geral"
        subtitle="Estado do ecossistema em tempo quase real"
      />

      <div className="flex flex-col gap-4 md:flex-row">
        {STATS.map((stat) => (
          <StatCard key={stat.id} {...stat} />
        ))}
      </div>

      <div className="flex justify-center">
        <Button>Ver detalhes</Button>
      </div>

      <FilterBar />

      <div className="flex flex-col gap-6 lg:flex-row">
        <ExperienceHealthCard />
        <IncidentsCard />
      </div>
    </div>
  );
}

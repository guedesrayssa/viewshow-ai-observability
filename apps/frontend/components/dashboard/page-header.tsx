import { Moon, Settings, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";

type PageHeaderProps = {
  title: string;
  subtitle: string;
};

export function PageHeader({ title, subtitle }: PageHeaderProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-3xl font-bold text-ink">{title}</h1>
        <p className="mt-1 text-sm text-accent">{subtitle}</p>
      </div>
      <div className="flex items-center gap-3">
        <Button icon={<Upload className="h-4 w-4" aria-hidden />}>
          Exportar
        </Button>
        <IconButton aria-label="Alternar tema escuro">
          <Moon className="h-4 w-4" aria-hidden />
        </IconButton>
        <IconButton aria-label="Configurações">
          <Settings className="h-4 w-4" aria-hidden />
        </IconButton>
      </div>
    </div>
  );
}

import Image from "next/image";
import { Avatar } from "@/components/ui/avatar";
import { SidebarNavItem } from "@/components/layout/sidebar-nav-item";
import { NAV_ITEMS } from "@/lib/navigation";

const USER_NAME = "Giovana Matsu";

export function Sidebar() {
  return (
    <aside className="flex h-screen w-56 shrink-0 flex-col bg-sidebar px-4 py-6">
      <div className="flex items-center gap-2 px-2 pb-8">
        <Image
          src="/logo-view-show.png"
          alt="View Show"
          width={28}
          height={28}
          className="rounded-full"
        />
        <span className="text-xs font-bold tracking-widest text-white">
          VIEW SHOW
        </span>
      </div>

      <nav className="flex flex-1 flex-col gap-1.5">
        {NAV_ITEMS.map((item) => (
          <SidebarNavItem key={item.href} {...item} />
        ))}
      </nav>

      <div className="flex items-center gap-3 border-t border-white/10 px-2 pt-4">
        <Avatar name={USER_NAME} />
        <span className="text-sm font-medium text-white">{USER_NAME}</span>
      </div>
    </aside>
  );
}

import { Link, useLocation } from "wouter";
import { LayoutDashboard, CalendarDays, Database, Activity, Snowflake, BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  const navigation = [
    { name: "Dashboard", href: "/", icon: LayoutDashboard },
    { name: "Pipeline Slate", href: "/slate", icon: Database },
    { name: "Raw Schedule", href: "/schedule", icon: CalendarDays },
    { name: "Daily SOP", href: "/sop", icon: BookOpen },
  ];

  return (
    <div className="flex min-h-screen w-full bg-background">
      {/* Sidebar */}
      <div className="w-64 border-r border-border bg-card flex flex-col">
        <div className="h-14 flex items-center px-4 border-b border-border">
          <div className="flex items-center gap-2 text-primary">
            <Snowflake className="h-6 w-6" />
            <span className="font-bold text-lg tracking-tight text-foreground">FROSTLINE</span>
          </div>
        </div>
        
        <div className="flex-1 py-4 flex flex-col gap-1 px-2">
          <div className="px-2 mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Pipeline Views
          </div>
          {navigation.map((item) => {
            const isActive = location === item.href;
            const Icon = item.icon;
            return (
              <Link 
                key={item.name} 
                href={item.href}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                  isActive 
                    ? "bg-primary/10 text-primary" 
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                )}
                data-testid={`link-nav-${item.href === "/" ? "dashboard" : item.href.slice(1)}`}
              >
                <Icon className="h-4 w-4" />
                {item.name}
              </Link>
            );
          })}
        </div>

        <div className="p-4 border-t border-border mt-auto">
          <div className="flex items-center gap-3 px-3 py-2 rounded-md bg-secondary/50 text-xs text-muted-foreground">
            <Activity className="h-4 w-4 text-emerald-500" />
            <span>System Online</span>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col h-screen overflow-hidden">
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}

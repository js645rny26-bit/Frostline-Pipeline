import React from "react";
import { format } from "date-fns";
import { Calendar as CalendarIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface DatePickerProps {
  date: string;
  onDateChange: (date: string) => void;
  className?: string;
}

export function DatePicker({ date, onDateChange, className }: DatePickerProps) {
  return (
    <div className={cn("relative flex items-center", className)}>
      <CalendarIcon className="absolute left-3 h-4 w-4 text-muted-foreground pointer-events-none" />
      <input
        type="date"
        value={date}
        onChange={(e) => onDateChange(e.target.value)}
        className="h-9 w-[160px] rounded-md border border-input bg-transparent pl-9 pr-3 text-sm text-foreground shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [color-scheme:dark]"
      />
    </div>
  );
}

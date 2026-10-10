import type { ProjectCost } from "../../lib/api";
import { formatNumber, formatUnit } from "../../lib/format";
import { StatCell, StatStrip } from "../ui/stat-strip";
import { CapMeter, Sparkline } from "./charts";
import { type ChangeCost, formatCost } from "./cost-format";

const hours = (seconds: number) => seconds / 3600;
const formatHours = (h: number) => formatUnit(h, "h", 1);

/**
 * Free-tier meters (AGENTS.md sections 7.3, 44) from `usage_counters`, plus the Project's
 * recorded spend over the Changes on this page. The call and Sandbox counters are account-wide.
 * OpenRouter is free up to its daily cap; then runs overflow to Gemini, whose spend the AI Gateway
 * caps per environment (`meters.vertexSpendLimitUsd` per 30 days; ADR 0016, 0017). Gemini spend
 * shows in "Project model spend".
 */
export function UsageMeters({
  meters,
  changes,
}: {
  meters: ProjectCost["meters"];
  changes: ChangeCost[];
}) {
  const projectSpend = changes.reduce((sum, c) => sum + c.costUsd, 0);
  const projectCalls = changes.reduce((sum, c) => sum + c.modelCalls, 0);
  const sandboxHours = hours(meters.sandboxSecondsMonth);
  const sandboxCap = hours(meters.sandboxMonthlyCapSeconds);
  const days = meters.agentModelCallsByDay;

  return (
    <StatStrip>
      <StatCell
        label="Model calls today"
        value={formatNumber(meters.agentModelCallsToday)}
        unit={`/ ${formatNumber(meters.agentDailyCallCap)}`}
        footnote={`account-wide · ${meters.day} UTC`}
      >
        <CapMeter
          label="daily cap"
          value={meters.agentModelCallsToday}
          cap={meters.agentDailyCallCap}
          format={(n) => formatNumber(n)}
        />
        <div className="grid gap-1">
          <Sparkline
            label={`Agent model calls per day, last ${days.length} days`}
            unit="calls"
            points={days.map((d) => ({ label: d.day, value: d.count }))}
          />
          <p className="font-mono text-[10px] text-kumo-subtle">
            last {days.length} days · peak {formatNumber(Math.max(0, ...days.map((d) => d.count)))}
          </p>
        </div>
      </StatCell>
      <StatCell
        label="OpenRouter today"
        value={formatNumber(meters.openrouterCallsToday)}
        unit={`/ ${formatNumber(meters.openrouterDailyCallCap)}`}
        footnote={
          meters.vertexSpendLimitedToday
            ? `Gemini spend cap reached · $${formatNumber(meters.vertexSpendLimitUsd)} per 30 days`
            : meters.openrouterUsedUpToday
              ? "used up · new runs use Gemini (paid, capped)"
              : "free models · then Gemini overflow"
        }
      >
        <CapMeter
          label="free cap"
          value={
            meters.openrouterUsedUpToday
              ? meters.openrouterDailyCallCap
              : meters.openrouterCallsToday
          }
          cap={meters.openrouterDailyCallCap}
          format={(n) => formatNumber(n)}
        />
      </StatCell>
      <StatCell
        label="Sandbox this month"
        value={formatNumber(sandboxHours, 1)}
        unit={`h / ${formatNumber(sandboxCap)} h`}
        footnote={`account-wide · ${meters.month} · ${formatNumber(meters.sandboxSecondsMonth)} s`}
      >
        <CapMeter label="monthly cap" value={sandboxHours} cap={sandboxCap} format={formatHours} />
      </StatCell>
      <StatCell
        label="Clef-flash today"
        value={formatNumber(meters.clefFlashCallsToday)}
        unit={`/ ${formatNumber(meters.clefDailyCap)}`}
        footnote="account-wide · wakeups and routes"
      >
        <CapMeter
          label="daily cap"
          value={meters.clefFlashCallsToday}
          cap={meters.clefDailyCap}
          format={(n) => formatNumber(n)}
        />
      </StatCell>
      <StatCell
        label="Project model spend"
        value={formatCost(projectSpend)}
        footnote={`${formatNumber(projectCalls)} calls · newest ${formatNumber(changes.length)} Changes`}
      />
    </StatStrip>
  );
}
UsageMeters.displayName = "UsageMeters";

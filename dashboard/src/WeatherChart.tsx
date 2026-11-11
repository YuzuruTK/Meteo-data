import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { stationColor } from "./weather";
export default function WeatherChart({
  points,
  stations,
  unit,
  formatTime,
}: {
  points: Array<Record<string, string | number | null>>;
  stations: Array<{ id: string; name: string }>;
  unit: string | undefined;
  formatTime: (value: string) => string;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={points}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="time"
          tickFormatter={(v) => formatTime(new Date(Number(v)).toISOString())}
          minTickGap={70}
        />
        <YAxis width={48} />
        <Tooltip
          labelFormatter={(v) => formatTime(new Date(Number(v)).toISOString())}
        />
        <Legend />
        {stations.map((s) => (
          <Line
            key={s.id}
            dataKey={s.id}
            name={`${s.name} (${unit})`}
            stroke={stationColor(s.id)}
            strokeWidth={2}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

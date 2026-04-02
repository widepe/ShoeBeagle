export const SOURCE_PRIORITY = [
  "RunRepeat",
  "The Running Clinic",
  "Running Warehouse",
  "Doctors of Running",
  "RoadTrailRun",
  "Believe in the Run",
  "OutdoorGearLab",
  "Road Runner Sports",
  "Running Shoes Guru",
  "RTINGS",
];

export function getSourceRank(name) {
  const i = SOURCE_PRIORITY.findIndex(
    (x) => x.toLowerCase() === String(name || "").toLowerCase()
  );
  return i === -1 ? 999 : i;
}

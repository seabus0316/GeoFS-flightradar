(function () {
  "use strict";

  const ENDPOINT =
    "https://radar-sse-production.up.railway.app/api/atc/position";
  const SEND_INTERVAL_MS = 1500;

  let wasOnGround = true;
  let takeoffTimeUTC = "";

  function calculateAGL() {
    try {
      const altitudeMSL = geofs?.animation?.values?.altitude;
      const groundElevationFeet =
        geofs?.animation?.values?.groundElevationFeet;
      const aircraft = geofs?.aircraft?.instance;

      if (
        typeof altitudeMSL === "number" &&
        typeof groundElevationFeet === "number" &&
        aircraft?.collisionPoints?.length >= 2
      ) {
        const collisionZFeet =
          aircraft.collisionPoints[
            aircraft.collisionPoints.length - 2
          ].worldPosition[2] * 3.2808399;

        return Math.round(
          altitudeMSL - groundElevationFeet + collisionZFeet
        );
      }
    } catch {}
    return null;
  }

  function checkTakeoff() {
    const onGround = geofs?.aircraft?.instance?.groundContact ?? true;
    if (wasOnGround && !onGround) {
      takeoffTimeUTC = new Date().toISOString();
    }
    wasOnGround = onGround;
  }

  function buildPayload() {
    const inst = geofs?.aircraft?.instance;
    if (!inst) return null;

    const lla = inst.llaLocation;
    if (!lla || typeof lla[0] !== "number") return null;

    const altMeters = lla[2] || 0;
    const altMSL = altMeters * 3.28084;
    const altAGL = calculateAGL();

    checkTakeoff();

    const info = { dep: "", arr: "", flt: "", sqk: "" };

    return {
      id: geofs.userRecord.googleid || geofs.userRecord.callsign,
      googleId: geofs.userRecord.googleid || null,
      callsign: geofs.userRecord.callsign,
      type: inst.aircraftRecord?.name || "Unknown",
      lat: lla[0],
      lon: lla[1],
      alt:
        typeof altAGL === "number"
          ? altAGL
          : Math.round(altMSL),
      altMSL: Math.round(altMSL),
      heading: Math.round(
        geofs.animation.values.heading360 || 0
      ),
      speed: Math.round(
        geofs.animation.values.kias || 0
      ),
      flightNo: info.flt,
      departure: info.dep,
      arrival: info.arr,
      takeoffTime: takeoffTimeUTC,
      squawk: info.sqk,
      flightPlan: geofs.flightPlan?.export
        ? geofs.flightPlan.export()
        : [],
      nextWaypoint:
        geofs.flightPlan?.trackedWaypoint?.ident || null,
      vspeed: Math.floor(
        geofs.animation?.values?.verticalSpeed || 0
      ),
    };
  }

  async function sendPosition() {
    const payload = buildPayload();
    if (!payload) return;

    try {
      await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {}
  }

  setInterval(() => {
    if (!window.geofs || !geofs.aircraft?.instance) return;
    sendPosition();
  }, SEND_INTERVAL_MS);
})();
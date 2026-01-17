
(function () {
  "use strict";

  const ENDPOINT =
    "https://sse.radarthing.com/api/atc/position";
  const SEND_INTERVAL_MS = 5000;

  let wasOnGround = true;
  let takeoffTimeUTC = "";

  function calculateAGL() {
    try {
      const altMSL = geofs.animation.values.altitude;
      const ground =
        geofs.animation.values.groundElevationFeet;
      const aircraft = geofs.aircraft.instance;

      if (
        aircraft.collisionPoints?.length >= 2
      ) {
        const z =
          aircraft.collisionPoints[
            aircraft.collisionPoints.length - 2
          ].worldPosition[2] * 3.2808399;

        return Math.round(altMSL - ground + z);
      }
    } catch {}
    return null;
  }

  function checkTakeoff() {
    const onGround =
      geofs.aircraft.instance.groundContact ?? true;
    if (wasOnGround && !onGround) {
      takeoffTimeUTC = new Date().toISOString();
    }
    wasOnGround = onGround;
  }

  function buildPayload() {
    const info = JSON.parse(
      localStorage.getItem("geofsFlightInfo")
    );

    if (
      !info ||
      !info.departure ||
      !info.arrival ||
      !info.flightNo
    ) {
      return null;
    }

    const inst = geofs.aircraft.instance;
    const lla = inst.llaLocation;
    if (!lla) return null;

    const altMSL = (lla[2] || 0) * 3.28084;
    const altAGL = calculateAGL();

    checkTakeoff();

    return {
      id:
        geofs.userRecord.googleid ||
        geofs.userRecord.callsign,
      googleId: geofs.userRecord.googleid || null,
      callsign: geofs.userRecord.callsign,
      type:
        inst.aircraftRecord?.name || "Unknown",
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
      flightNo: info.flightNo,
      departure: info.departure,
      arrival: info.arrival,
      takeoffTime: takeoffTimeUTC,
      squawk: info.squawk || "",
      flightPlan:
        geofs.flightPlan?.export?.() || [],
      nextWaypoint:
        geofs.flightPlan?.trackedWaypoint?.ident ||
        null,
      vspeed: Math.floor(
        geofs.animation.values.verticalSpeed || 0
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

  const wait = setInterval(() => {
    if (window.geofs?.aircraft?.instance) {
      clearInterval(wait);
      setInterval(sendPosition, SEND_INTERVAL_MS);
    }
  }, 500);
})();
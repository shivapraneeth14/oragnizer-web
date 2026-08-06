-- Event location coordinates (map picker) — additive only.
-- communities table is intentionally untouched (city/state/country only).

alter table events
  add column latitude numeric(10, 7),
  add column longitude numeric(10, 7);

alter table events
  add constraint events_latitude_check check (
    latitude is null or (latitude >= -90 and latitude <= 90)
  );

alter table events
  add constraint events_longitude_check check (
    longitude is null or (longitude >= -180 and longitude <= 180)
  );

-- How much the pin is claiming.
--
-- Every orchard has a coordinate, and until now every coordinate looked the
-- same on the page: one dot, one Directions button that navigates to it. But
-- they are not the same kind of fact.
--
--   Some are published by the source. PA Preferred puts each member's position
--   in the page, OpenStreetMap's are surveyed. Those are the farm's own answer.
--
--   Some we worked out from an address. A house number and a street usually
--   geocode to the building, which is as good.
--
--   And some are the best available answer to an address that does not have a
--   building in it. Rogers Orchards-Sunnymount Farm is addressed
--   "Rt. 322 Meriden-Waterbury Road" — no house number, because the farm is
--   addressed from the route. The geocoder returns a point on that road, which
--   is the right road in the right town and may be a mile from the gate.
--
-- The third kind was previously unpublishable. Not because the position is
-- useless — it is genuinely helpful for "is this near me" — but because the
-- page had no way to say it was approximate, and a pin that looks exact while
-- being a mile out is the failure this whole project is arranged against.
--
-- NULL means nobody recorded a precision, which is where all 252 existing rows
-- sit. It is NOT a synonym for 'exact': claiming exactness for every row we
-- happen to already hold would be inventing 252 assertions to avoid writing a
-- nullable column. The page says nothing when it is null, exactly as today.
--
-- 'approximate' is therefore the only value that changes what a visitor sees,
-- and it is the only one anything currently writes. 'exact' exists so a source
-- that states its precision has somewhere to put it.

set search_path = public, extensions;

create type position_precision as enum ('exact', 'approximate');

alter table orchards
  add column position_precision position_precision;

comment on column orchards.position_precision is
  'How much the coordinate claims. NULL = not recorded, not a claim of exactness. '
  '''approximate'' means the pin is the right area but not the building — the page '
  'says so and tells people to ring ahead.';

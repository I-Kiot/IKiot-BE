import {
  columnsOfLocation,
  locationIdOf,
  locationWhere,
  postingWhere,
  toLocationColumns,
  toLocationRef,
  withNamedPosting,
} from './location-ref.dto';
import { LocationKind, LocationType } from '../constants/location-type';

const BRANCH = '11111111-1111-4111-8111-111111111111';
const WAREHOUSE = '22222222-2222-4222-8222-222222222222';

// Guards that the API's `locationId`/`locationType` pair and the DB's single `location_id` + `Location.type` stay in step.
describe('location reference mapping', () => {
  it('writes exactly one side per reference', () => {
    expect(
      toLocationColumns({
        locationId: BRANCH,
        locationType: LocationType.BRANCH,
      }),
    ).toEqual({ branchId: BRANCH, warehouseId: null });

    expect(
      toLocationColumns({
        locationId: WAREHOUSE,
        locationType: LocationType.WAREHOUSE,
      }),
    ).toEqual({ branchId: null, warehouseId: WAREHOUSE });
  });

  it('round-trips back to the API shape', () => {
    const ref = { locationId: WAREHOUSE, locationType: LocationType.WAREHOUSE };
    expect(toLocationRef(toLocationColumns(ref))).toEqual(ref);
  });

  it('reads a row naming neither location as no location', () => {
    expect(toLocationRef({ branchId: null, warehouseId: null })).toBeNull();
  });

  it('stores either side in the one location_id column', () => {
    expect(locationIdOf({ branchId: BRANCH, warehouseId: null })).toBe(BRANCH);
    expect(locationIdOf({ branchId: null, warehouseId: WAREHOUSE })).toBe(
      WAREHOUSE,
    );
    expect(locationIdOf({ branchId: null, warehouseId: null })).toBeNull();
  });

  it('reads a loaded Location back by its kind', () => {
    expect(
      columnsOfLocation({ id: BRANCH, type: LocationKind.BRANCH }),
    ).toEqual({ branchId: BRANCH, warehouseId: null });
    expect(
      columnsOfLocation({ id: WAREHOUSE, type: LocationKind.WAREHOUSE }),
    ).toEqual({ branchId: null, warehouseId: WAREHOUSE });
    expect(columnsOfLocation(null)).toEqual({
      branchId: null,
      warehouseId: null,
    });
  });
});

describe('locationWhere', () => {
  it('adds no filter when nothing was asked for', () => {
    expect(locationWhere({})).toEqual({});
  });

  it('narrows to one location of the named kind when both parts are given', () => {
    expect(
      locationWhere({ locationId: BRANCH, locationType: LocationType.BRANCH }),
    ).toEqual({ locationId: BRANCH, location: { type: LocationKind.BRANCH } });
  });

  it('narrows to a kind of location when only the type is given', () => {
    expect(locationWhere({ locationType: LocationType.WAREHOUSE })).toEqual({
      location: { type: LocationKind.WAREHOUSE },
    });
  });
});

describe('postingWhere', () => {
  it('adds no filter for an empty scope', () => {
    expect(postingWhere({})).toEqual({});
  });

  it('narrows to the one location named', () => {
    expect(postingWhere({ branchId: BRANCH })).toEqual({
      AND: [{ locationId: BRANCH }],
    });
  });

  it('matches nothing when both a branch and a warehouse are named, as the old two-column AND did', () => {
    expect(postingWhere({ branchId: BRANCH, warehouseId: WAREHOUSE })).toEqual({
      AND: [{ locationId: BRANCH }, { locationId: WAREHOUSE }],
    });
  });
});

describe('withNamedPosting', () => {
  it('rebuilds branchId/branch from a BRANCH location and drops `location`', () => {
    expect(
      withNamedPosting({
        id: 'u1',
        location: { id: BRANCH, type: LocationKind.BRANCH, name: 'CN 1' },
      }),
    ).toEqual({
      id: 'u1',
      branchId: BRANCH,
      warehouseId: null,
      branch: { id: BRANCH, name: 'CN 1' },
      warehouse: null,
    });
  });

  it('answers an unposted user with both sides null', () => {
    expect(withNamedPosting({ id: 'u1', location: null })).toEqual({
      id: 'u1',
      branchId: null,
      warehouseId: null,
      branch: null,
      warehouse: null,
    });
  });
});

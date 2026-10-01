import {
  locationWhere,
  toLocationColumns,
  toLocationRef,
} from './location-ref.dto';
import { LocationType } from '../constants/location-type';

const BRANCH = '11111111-1111-4111-8111-111111111111';
const WAREHOUSE = '22222222-2222-4222-8222-222222222222';

// Guards that the API's `locationId`/`locationType` pair and the DB's `branch_id`/`warehouse_id` pair stay in step.
describe('location reference mapping', () => {
  it('writes exactly one column per reference', () => {
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
});

describe('locationWhere', () => {
  it('adds no filter when nothing was asked for', () => {
    expect(locationWhere({})).toEqual({});
  });

  it('narrows to one location when both parts are given', () => {
    expect(
      locationWhere({ locationId: BRANCH, locationType: LocationType.BRANCH }),
    ).toEqual({ branchId: BRANCH });
  });

  it('narrows to a kind of location when only the type is given', () => {
    expect(locationWhere({ locationType: LocationType.WAREHOUSE })).toEqual({
      warehouseId: { not: null },
    });
  });
});

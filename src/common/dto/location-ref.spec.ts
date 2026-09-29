import {
  columnsOfLocation,
  locationMatcher,
  locationWhere,
  postingWhere,
  toLocationRef,
  withNamedPosting,
} from './location-ref.dto';
import type { LocationRefQueryDto } from './location-ref.dto';
import { LocationType, isReturnDirection } from '../constants/location-type';

const BRANCH = '11111111-1111-4111-8111-111111111111';
const WAREHOUSE = '22222222-2222-4222-8222-222222222222';

// Guards that the branch/warehouse pair other modules still reason in and the DB's single `location_id` + `Location.type` stay in step.
describe('location reference mapping', () => {
  it('answers the pair as a { locationId, locationType } reference', () => {
    expect(toLocationRef({ branchId: BRANCH, warehouseId: null })).toEqual({
      locationId: BRANCH,
      locationType: LocationType.BRANCH,
    });
    expect(toLocationRef({ branchId: null, warehouseId: WAREHOUSE })).toEqual({
      locationId: WAREHOUSE,
      locationType: LocationType.WAREHOUSE,
    });
  });

  it('reads a row naming neither location as no location', () => {
    expect(toLocationRef({ branchId: null, warehouseId: null })).toBeNull();
  });

  it('reads a loaded Location back by its kind', () => {
    expect(
      columnsOfLocation({ id: BRANCH, type: LocationType.BRANCH }),
    ).toEqual({ branchId: BRANCH, warehouseId: null });
    expect(
      columnsOfLocation({ id: WAREHOUSE, type: LocationType.WAREHOUSE }),
    ).toEqual({ branchId: null, warehouseId: WAREHOUSE });
    expect(columnsOfLocation(null)).toEqual({
      branchId: null,
      warehouseId: null,
    });
  });
});

// `locationWhere` filters in SQL, `locationMatcher` in memory - stock reads rely on both
// answering the same question, so every case checks the two side by side.
describe('location filter', () => {
  const rows = [
    { locationId: BRANCH, location: { type: LocationType.BRANCH } },
    { locationId: WAREHOUSE, location: { type: LocationType.WAREHOUSE } },
  ];

  it.each<[string, LocationRefQueryDto, string[], object]>([
    ['nothing asked', {}, [BRANCH, WAREHOUSE], {}],
    ['one location', { locationId: BRANCH }, [BRANCH], { locationId: BRANCH }],
    [
      'one kind',
      { locationType: LocationType.WAREHOUSE },
      [WAREHOUSE],
      { location: { type: LocationType.WAREHOUSE } },
    ],
    [
      // The two conditions are ANDed: a branch's id with the warehouse kind matches nothing.
      'id and kind that disagree',
      { locationId: BRANCH, locationType: LocationType.WAREHOUSE },
      [],
      { locationId: BRANCH, location: { type: LocationType.WAREHOUSE } },
    ],
  ])('%s', (_label, query, matched, where) => {
    expect(
      rows.filter(locationMatcher(query)).map((row) => row.locationId),
    ).toEqual(matched);
    expect(locationWhere(query)).toEqual(where);
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
        location: { id: BRANCH, type: LocationType.BRANCH, name: 'CN 1' },
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

describe('isReturnDirection', () => {
  it('branch → warehouse is a return, nothing else is (plan 2026-09-29, QĐ-1)', () => {
    expect(isReturnDirection(LocationType.BRANCH, LocationType.WAREHOUSE)).toBe(
      true,
    );
    expect(isReturnDirection(LocationType.WAREHOUSE, LocationType.BRANCH)).toBe(
      false,
    );
    expect(isReturnDirection(LocationType.BRANCH, LocationType.BRANCH)).toBe(
      false,
    );
  });
});

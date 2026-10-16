import { sameValues, valueMap } from './product-attributes';

describe('valueMap / sameValues', () => {
  it('keys values by attribute and ignores free rows and blanks', () => {
    const map = valueMap([
      { attributeId: 'color', value: ' Óc chó ' },
      { attributeId: null, value: 'ghi chú tự do' },
      { attributeId: 'size', value: '  ' },
    ]);
    expect([...map]).toEqual([['color', 'Óc chó']]);
  });

  it('treats the same values in another order and case as the same variant', () => {
    const a = valueMap([
      { attributeId: 'color', value: 'Óc chó' },
      { attributeId: 'size', value: '140' },
    ]);
    const b = valueMap([
      { attributeId: 'size', value: '140' },
      { attributeId: 'color', value: 'óc chó' },
    ]);
    expect(sameValues(a, b)).toBe(true);
  });

  it('tells apart a changed value and a missing attribute', () => {
    const base = valueMap([
      { attributeId: 'color', value: 'Óc chó' },
      { attributeId: 'size', value: '140' },
    ]);
    expect(
      sameValues(
        base,
        valueMap([
          { attributeId: 'color', value: 'Trắng' },
          { attributeId: 'size', value: '140' },
        ]),
      ),
    ).toBe(false);
    expect(
      sameValues(base, valueMap([{ attributeId: 'color', value: 'Óc chó' }])),
    ).toBe(false);
  });
});

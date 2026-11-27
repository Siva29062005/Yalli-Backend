import { parseImportFile } from './import-file.js';
import {
  convertOpenCart,
  decimalToPaise,
  parseCsv,
  parseTaxSheet,
  readPhpMyAdminJson,
} from './opencart.js';

/** A small phpMyAdmin JSON export of an OpenCart 4 store (values are strings, as phpMyAdmin writes them). */
const exportJson = [
  { type: 'header', version: '5.2.1' },
  { type: 'database', name: 'opencart' },
  {
    type: 'table',
    name: 'oc_category',
    data: [
      { category_id: '20', parent_id: '0', status: '1' },
      { category_id: '27', parent_id: '20', status: '1' },
      { category_id: '30', parent_id: '0', status: '0' },
      { category_id: '40', parent_id: '99', status: '1' },
    ],
  },
  {
    type: 'table',
    name: 'oc_category_description',
    data: [
      { category_id: '20', language_id: '1', name: 'Kitchen &amp; Dining' },
      { category_id: '27', language_id: '1', name: 'Storage' },
      { category_id: '27', language_id: '2', name: 'Lagerung' },
      { category_id: '30', language_id: '1', name: 'Old stuff' },
      { category_id: '40', language_id: '1', name: 'Orphans' },
    ],
  },
  {
    type: 'table',
    name: 'oc_product',
    data: [
      {
        product_id: '42',
        model: 'MOMO 3in1',
        sku: '',
        price: '799.0000',
        quantity: '7',
        status: '1',
        image: 'catalog/momo.jpg',
        manufacturer_id: '5',
      },
      {
        product_id: '43',
        model: 'KNIFE-1',
        sku: 'KNIFE-1',
        price: '199.9950',
        quantity: '-2',
        status: '0',
        image: '',
        manufacturer_id: '0',
      },
      {
        product_id: '44',
        model: 'KNIFE-1',
        sku: '',
        price: '0.0000',
        quantity: '1',
        status: '1',
        image: null,
        manufacturer_id: '0',
      },
      {
        product_id: '45',
        model: 'LAMP',
        sku: '',
        price: '349.5000',
        quantity: '3',
        status: '1',
        image: 'catalog/lamp.png',
        manufacturer_id: '0',
      },
      {
        product_id: '46',
        model: 'KNIFE-1',
        sku: '',
        price: '99.0000',
        quantity: '1',
        status: '1',
        image: null,
        manufacturer_id: '0',
      },
    ],
  },
  {
    type: 'table',
    name: 'oc_product_description',
    data: [
      {
        product_id: '42',
        language_id: '1',
        name: '3 in 1 Momos Maker',
        description: '&lt;p&gt;Steams &amp;amp; more&lt;/p&gt;',
        tag: 'momos, steamer, momos',
        meta_description: 'Makes &quot;momos&quot;',
      },
      {
        product_id: '43',
        language_id: '1',
        name: 'Knife and Peeler',
        description: '',
        tag: '',
        meta_description: '',
      },
      {
        product_id: '44',
        language_id: '1',
        name: 'Free sample',
        description: '',
        tag: '',
        meta_description: '',
      },
      {
        product_id: '45',
        language_id: '1',
        name: 'Night Lamp',
        description: '',
        tag: '',
        meta_description: '',
      },
      {
        product_id: '46',
        language_id: '1',
        name: 'Another knife',
        description: '',
        tag: '',
        meta_description: '',
      },
    ],
  },
  {
    type: 'table',
    name: 'oc_product_to_category',
    data: [
      { product_id: '42', category_id: '27' },
      { product_id: '43', category_id: '30' },
      { product_id: '45', category_id: '20' },
      { product_id: '46', category_id: '40' },
    ],
  },
  {
    type: 'table',
    name: 'oc_product_special',
    data: [
      {
        product_id: '42',
        customer_group_id: '1',
        priority: '1',
        price: '690.0000',
        date_start: '0000-00-00',
        date_end: '0000-00-00',
      },
      {
        product_id: '42',
        customer_group_id: '2',
        priority: '0',
        price: '500.0000',
        date_start: '0000-00-00',
        date_end: '0000-00-00',
      },
      {
        product_id: '45',
        customer_group_id: '1',
        priority: '1',
        price: '299.0000',
        date_start: '2026-01-01',
        date_end: '2026-01-31',
      },
      {
        product_id: '43',
        customer_group_id: '1',
        priority: '1',
        price: '250.0000',
        date_start: '0000-00-00',
        date_end: '0000-00-00',
      },
    ],
  },
  {
    type: 'table',
    name: 'oc_manufacturer',
    data: [{ manufacturer_id: '5', name: 'Yalli' }],
  },
  {
    type: 'table',
    name: 'oc_product_image',
    data: [
      { product_id: '42', image: 'catalog/momo-2.jpg', sort_order: '2' },
      { product_id: '42', image: 'catalog/momo-1.jpg', sort_order: '1' },
    ],
  },
  {
    type: 'table',
    name: 'oc_product_option',
    data: [{ product_id: '45', option_id: '1' }],
  },
  {
    type: 'table',
    name: 'oc_seo_url',
    data: [
      {
        store_id: '0',
        language_id: '1',
        key: 'product_id',
        value: '42',
        keyword: '3in1MomosMakerMachine',
      },
      {
        store_id: '0',
        language_id: '1',
        key: 'path',
        value: '20',
        keyword: 'kitchen-dining',
      },
      {
        store_id: '0',
        language_id: '2',
        key: 'product_id',
        value: '45',
        keyword: 'nachtlampe',
      },
    ],
  },
];

describe('OpenCart conversion', () => {
  const tables = readPhpMyAdminJson(exportJson);
  const r = convertOpenCart(tables, { today: '2026-11-27' });
  const product = (key: string) =>
    r.file.products.find((p) => p['key'] === key) as
      Record<string, any> | undefined;

  it('produces a file the importer accepts as it is', () => {
    const parsed = parseImportFile(r.file);
    expect(parsed.ok ? [] : parsed.issues).toEqual([]);
  });

  it('categories: parents first, names decoded, SEO keyword as slug; disabled ones left out; orphans at the top', () => {
    expect(
      r.file.categories.map((c) => [c.key, c.name, c.slug, c.parentKey]),
    ).toEqual([
      ['oc-c20', 'Kitchen & Dining', 'kitchen-dining', null],
      ['oc-c27', 'Storage', 'storage', 'oc-c20'],
      ['oc-c40', 'Orphans', 'orphans', null],
      ['oc-uncategorised', 'More products', 'more-products', null],
    ]);
    expect(r.warnings.join('\n')).toMatch(/Category 30 is disabled/);
    expect(r.warnings.join('\n')).toMatch(
      /Category 40: its parent 99 is missing/,
    );
  });

  it('products: exact paise, current default-group special, SEO slug, tags de-duplicated, model as SKU', () => {
    const momo = product('oc-p42')!;
    expect(momo).toMatchObject({
      name: '3 in 1 Momos Maker',
      brand: 'Yalli',
      categoryKeys: ['oc-c27'],
      tags: ['momos', 'steamer'],
      summary: 'Makes "momos"',
      status: 'PUBLISHED',
      variants: [
        {
          sku: 'MOMO-3in1',
          priceMinor: 79_900,
          salePriceMinor: 69_000,
          stock: 7,
        },
      ],
    });
    expect(momo['slug']).toBe('3in1momosmakermachine');
    expect(momo['descriptionHtml']).toBe(
      '&lt;p&gt;Steams &amp;amp; more&lt;/p&gt;',
    ); // decoded by the importer (option)
  });

  it('adjusts and reports: negative stock, expired or too-high specials, zero prices, duplicate SKUs, options', () => {
    const knife = product('oc-p43')!;
    expect(knife['variants'][0]).toEqual({
      sku: 'KNIFE-1',
      priceMinor: 20_000,
      stock: 0,
    }); // 199.995 -> 200.00, half-up
    expect(knife['status']).toBe('DRAFT');
    expect(knife['categoryKeys']).toEqual(['oc-uncategorised']); // its only category is disabled
    expect(product('oc-p44')).toBeUndefined(); // price 0: not imported
    expect(product('oc-p45')!['variants'][0]).not.toHaveProperty(
      'salePriceMinor',
    ); // the January special is over
    expect(product('oc-p46')!['variants'][0]['sku']).toBe('KNIFE-1-OC46');
    const w = r.warnings.join('\n');
    expect(w).toMatch(/Product 43 .*stock -2 counted as 0/);
    expect(w).toMatch(
      /Product 43 .*special price 250.0000 is not below the price/,
    );
    expect(w).toMatch(/Product 44 .*no valid price/);
    expect(w).toMatch(/Product 46 .*SKU KNIFE-1 is used twice/);
    expect(w).toMatch(/Product 45 .*OpenCart options .*NOT imported/);
  });

  it('lists images in order (main first), redirects for every product and category, and a tax sheet', () => {
    expect(
      r.images
        .find((i) => i.productSlug === '3in1momosmakermachine')
        ?.images.map((i) => i.path),
    ).toEqual(['catalog/momo.jpg', 'catalog/momo-1.jpg', 'catalog/momo-2.jpg']);
    expect(r.redirects).toContainEqual({
      kind: 'product',
      id: '42',
      keyword: '3in1MomosMakerMachine',
      to: '/products/3in1momosmakermachine',
    });
    expect(r.redirects).toContainEqual({
      kind: 'product',
      id: '45',
      keyword: null,
      to: '/products/night-lamp',
    });
    expect(r.redirects).toContainEqual({
      kind: 'category',
      id: '20',
      keyword: 'kitchen-dining',
      to: '/catalog/kitchen-dining',
    });
    expect(r.taxSheet).toContainEqual([
      'MOMO-3in1',
      '3 in 1 Momos Maker',
      '',
      '',
    ]);
  });

  it('applies the filled-in tax sheet', () => {
    const { tax, problems } = parseTaxSheet(
      'sku,product,gst_rate_percent,hsn_code\r\n"MOMO-3in1","3 in 1 Momos Maker",12,7323\r\nKNIFE-1,Knife,18,\r\nLAMP,Lamp,,\r\n',
    );
    expect(problems).toEqual([]);
    const withTax = convertOpenCart(tables, { today: '2026-11-27', tax });
    expect(
      withTax.file.products.find((p) => p['key'] === 'oc-p42'),
    ).toMatchObject({ gstRateBps: 1200, hsnCode: '7323' });
    expect(
      withTax.file.products.find((p) => p['key'] === 'oc-p43'),
    ).toMatchObject({ gstRateBps: 1800 });
    expect(
      withTax.file.products.find((p) => p['key'] === 'oc-p45'),
    ).not.toHaveProperty('gstRateBps');
  });

  it('refuses a tax sheet with a rate that is not a GST slab or a bad HSN code', () => {
    const { problems } = parseTaxSheet(
      'sku,gst_rate_percent,hsn_code\nA,15,\nB,18,12\nC,0.25,\nD,2.5,\n',
    );
    // 0.25 % is a slab; 2.5 % is half of 5 % (CGST), not a rate
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/line 2: A: GST rate "15"/);
    expect(problems[1]).toMatch(/line 3: B: HSN code "12"/);
    expect(problems[2]).toMatch(/line 5: D: GST rate "2.5"/);
  });

  it('refuses something that is not an OpenCart export', () => {
    expect(() => readPhpMyAdminJson({})).toThrow(/phpMyAdmin/);
    expect(() =>
      readPhpMyAdminJson([{ type: 'table', name: 'oc_product', data: [] }]),
    ).toThrow(/oc_product_description/);
  });
});

describe('helpers', () => {
  it('decimal strings to paise without floating point', () => {
    expect(decimalToPaise('499.0000')).toBe(49_900);
    expect(decimalToPaise('0.0050')).toBe(1);
    expect(decimalToPaise('0.0049')).toBe(0);
    expect(decimalToPaise('12')).toBe(1_200);
    expect(decimalToPaise('1234567.8')).toBe(123_456_780);
    for (const bad of ['', '-1.00', '1e3', 'abc', null])
      expect(decimalToPaise(bad)).toBeNull();
  });
  it('reads CSV with quotes, commas and both line ends', () => {
    expect(parseCsv('a,"b, c","d ""e"""\r\n1,2,3\n')).toEqual([
      ['a', 'b, c', 'd "e"'],
      ['1', '2', '3'],
    ]);
  });
});

describe('OpenCart conversion: review fixes', () => {
  const base = (over: Record<string, unknown[]> = {}) => {
    const t: Record<string, unknown[]> = {
      oc_category: [
        { category_id: '20', parent_id: '0', status: '1' },
        { category_id: '27', parent_id: '20', status: '1' },
      ],
      oc_category_description: [
        { category_id: '20', language_id: '1', name: 'Kitchen' },
        { category_id: '27', language_id: '1', name: 'Storage' },
      ],
      oc_product: [
        {
          product_id: '1',
          model: 'A1',
          sku: '',
          price: '500.0000',
          quantity: '1',
          status: '1',
          image: null,
          manufacturer_id: '0',
          tax_class_id: '0',
        },
      ],
      oc_product_description: [
        {
          product_id: '1',
          language_id: '1',
          name: 'Bowl',
          description: '',
          tag: '',
          meta_description: '',
        },
      ],
      oc_product_to_category: [{ product_id: '1', category_id: '27' }],
      ...over,
    };
    return readPhpMyAdminJson(
      Object.entries(t).map(([name, data]) => ({ type: 'table', name, data })),
    );
  };
  const today = '2026-11-27';

  it('keeps the sale window: ends at the start of its end date (as OpenCart), an upcoming sale starts later', () => {
    const special = (
      date_start: string,
      date_end: string,
      price = '400.0000',
    ) => ({
      product_id: '1',
      customer_group_id: '1',
      priority: '1',
      price,
      date_start,
      date_end,
    });
    const variant = (rows: unknown[]) =>
      (
        convertOpenCart(base({ oc_product_special: rows }), { today }).file
          .products[0] as { variants: Record<string, unknown>[] }
      ).variants[0]!;
    expect(variant([special('2026-11-01', '2026-12-05')])).toMatchObject({
      salePriceMinor: 40_000,
      saleStartsAt: '2026-11-01T00:00:00+05:30',
      saleEndsAt: '2026-12-05T00:00:00+05:30',
    });
    expect(variant([special('0000-00-00', '2026-11-27')])).not.toHaveProperty(
      'salePriceMinor',
    ); // over today
    expect(
      variant([special('2026-12-10', '2026-12-20', '450.0000')]),
    ).toMatchObject({
      salePriceMinor: 45_000,
      saleStartsAt: '2026-12-10T00:00:00+05:30',
    });
    const r = convertOpenCart(
      base({ oc_product_special: [special('2026-11-01', '2026-12-05')] }),
      { today },
    );
    const parsed = parseImportFile(r.file);
    expect(parsed.ok).toBe(true);
  });

  it('a product with an OpenCart tax class blocks the conversion unless prices are confirmed to include GST', () => {
    const taxed = base({
      oc_product: [
        {
          product_id: '1',
          model: 'A1',
          sku: '',
          price: '500.0000',
          quantity: '1',
          status: '1',
          image: null,
          manufacturer_id: '0',
          tax_class_id: '9',
        },
      ],
    });
    expect(convertOpenCart(taxed, { today }).blocking.join('\n')).toMatch(
      /tax class.*WITHOUT tax/,
    );
    expect(
      convertOpenCart(taxed, { today, pricesIncludeGst: true }).blocking,
    ).toEqual([]);
  });

  it('OpenCart 4 subcategory keywords (key "path", value "20_27") give the slug and the redirect', () => {
    const r = convertOpenCart(
      base({
        oc_seo_url: [
          {
            store_id: '0',
            language_id: '1',
            key: 'path',
            value: '20',
            keyword: 'kitchen',
          },
          {
            store_id: '0',
            language_id: '1',
            key: 'path',
            value: '20_27',
            keyword: 'kitchen/storage-boxes',
          },
        ],
      }),
      { today },
    );
    expect(r.file.categories.find((c) => c.key === 'oc-c27')?.slug).toBe(
      'storage-boxes',
    );
    expect(r.redirects).toContainEqual({
      kind: 'category',
      id: '20_27',
      keyword: 'kitchen/storage-boxes',
      to: '/catalog/storage-boxes',
    });
  });

  it('long names and long ids still give valid slugs and SKUs; huge prices are left out with a warning', () => {
    const r = convertOpenCart(
      base({
        oc_product: [
          {
            product_id: '1',
            model: 'X',
            sku: '',
            price: '10.00',
            quantity: '1',
            status: '1',
            image: null,
            manufacturer_id: '0',
          },
          {
            product_id: '1234567891',
            model: 'X',
            sku: '',
            price: '10.00',
            quantity: '1',
            status: '1',
            image: null,
            manufacturer_id: '0',
          },
          {
            product_id: '3',
            model: 'Y',
            sku: '',
            price: '20000000.0000',
            quantity: '1',
            status: '1',
            image: null,
            manufacturer_id: '0',
          },
        ],
        oc_product_description: [
          {
            product_id: '1',
            language_id: '1',
            name: 'a'.repeat(109) + ' bbbbbbbbbb',
            description: '',
            tag: '',
            meta_description: '',
          },
          {
            product_id: '1234567891',
            language_id: '1',
            name: 'a'.repeat(109) + ' bbbbbbbbbb',
            description: '',
            tag: '',
            meta_description: '',
          },
          {
            product_id: '3',
            language_id: '1',
            name: 'Gold',
            description: '',
            tag: '',
            meta_description: '',
          },
        ],
        oc_product_to_category: [
          { product_id: '1', category_id: '27' },
          { product_id: '1234567891', category_id: '27' },
          { product_id: '3', category_id: '27' },
        ],
      }),
      { today },
    );
    const parsed = parseImportFile(r.file);
    expect(parsed.ok ? [] : parsed.issues).toEqual([]);
    expect(r.file.products).toHaveLength(2);
    expect(r.warnings.join('\n')).toMatch(/above ₹1 crore/);
  });

  it('a multi-store export keeps only the chosen store; null rows are ignored', () => {
    const r = convertOpenCart(
      base({
        oc_product: [
          {
            product_id: '1',
            model: 'A1',
            sku: '',
            price: '500.0000',
            quantity: '1',
            status: '1',
            image: null,
            manufacturer_id: '0',
          },
          {
            product_id: '2',
            model: 'B1',
            sku: '',
            price: '500.0000',
            quantity: '1',
            status: '1',
            image: null,
            manufacturer_id: '0',
          },
          null,
        ],
        oc_product_description: [
          {
            product_id: '1',
            language_id: '1',
            name: 'Bowl',
            description: '',
            tag: '',
            meta_description: '',
          },
          {
            product_id: '2',
            language_id: '1',
            name: 'Other store',
            description: '',
            tag: '',
            meta_description: '',
          },
        ],
        oc_product_to_category: [
          { product_id: '1', category_id: '27' },
          { product_id: '2', category_id: '27' },
        ],
        oc_product_to_store: [
          { product_id: '1', store_id: '0' },
          { product_id: '2', store_id: '1' },
        ],
      }),
      { today },
    );
    expect(r.file.products.map((p) => p['name'])).toEqual(['Bowl']);
  });

  it('an HSN code without a GST rate is a problem (it would otherwise be lost)', () => {
    expect(
      parseTaxSheet('sku,gst_rate_percent,hsn_code\nA1,,7323\n').problems,
    ).toEqual(['line 2: A1: HSN code given without a GST rate']);
  });
});

// 本地模拟的外部世界：TikTok、飞书、Claude、阿里云、乐天、雅虎、汇率。
// 测试和演示都走真实的 HTTP 客户端代码，只把 fetch 换掉。
// 这里的校验规则取自官方接口文档，用来尽早发现请求体写错。
import { sign } from '../src/core/tiktok/sign.ts';
import type { FetchLike } from '../src/core/types.ts';

const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

export interface WorldOptions {
  appKey?: string;
  appSecret?: string;
  globalPermission?: boolean;
  listingCheckFails?: boolean;
  /** 同款的落地价，决定行情。 */
  marketPrices?: number[];
  chineseFirstPass?: boolean;
  sourceTitle?: string;
  priceCny?: number;
  tiktokFailsOnCreate?: boolean;
  /** 全球商品发布回执的状态。 */
  publishStatus?: 'SUCCESS' | 'DRAFT' | 'FAILED';
  /** 商品创建已生效，但响应是 502。用来验证不会重复提交。 */
  createAppliedThen502?: boolean;
  /** 这些价格会在页面文字里出现；不设时用标准页面。 */
  captureText?: string;
  descriptionParagraphs?: string[];
  warehouseStatus?: string;
  /** 模拟 getOrder 连续失败的次数。 */
  orderFetchFailures?: number;
}

export interface World {
  fetchImpl: FetchLike;
  appKey: string;
  appSecret: string;
  tiktokCalls: { method: string; path: string; body: any }[];
  created: any[];
  feishuMessages: { id: string; chatId: string; type: string; content: any }[];
  feishuUpdates: { id: string; content: any }[];
  order: any;
  claudeCalls: number;
  options: WorldOptions;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

const ok = (data: unknown) => json({ code: 0, message: 'Success', request_id: 'req-1', data });

function assertStrictSchema(node: any, path = '$'): void {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'object' && node.additionalProperties !== false) {
    throw new Error(`结构化输出要求 additionalProperties: false：${path}`);
  }
  for (const banned of ['minimum', 'maximum', 'minLength', 'maxLength', 'maxItems', 'multipleOf']) {
    if (banned in node) throw new Error(`结构化输出不支持 ${banned}：${path}`);
  }
  for (const [k, v] of Object.entries(node)) {
    if (Array.isArray(v)) v.forEach((x, i) => assertStrictSchema(x, `${path}.${k}[${i}]`));
    else if (typeof v === 'object') assertStrictSchema(v, `${path}.${k}`);
  }
}

export function createWorld(options: WorldOptions = {}): World {
  const appKey = options.appKey ?? 'test-app-key';
  const appSecret = options.appSecret ?? 'test-app-secret';
  const uploaded = new Set<string>();

  const world: World = {
    fetchImpl: null as unknown as FetchLike,
    appKey,
    appSecret,
    tiktokCalls: [],
    created: [],
    feishuMessages: [],
    feishuUpdates: [],
    order: null,
    claudeCalls: 0,
    options,
  };

  function tiktok(url: URL, init: RequestInit): Response | Promise<Response> {
    const path = url.pathname;
    const method = init.method ?? 'GET';
    const isForm = init.body instanceof FormData;
    const rawBody = typeof init.body === 'string' ? init.body : null;

    // 验签
    const query: [string, string][] = [...url.searchParams.entries()].filter(([k]) => k !== 'sign');
    const expected = sign({
      path,
      query,
      contentType: isForm ? 'multipart/form-data' : rawBody ? 'application/json' : null,
      body: rawBody,
      appSecret,
    });
    if (expected !== url.searchParams.get('sign')) return json({ code: 106001, message: 'Invalid sign' });
    const headers = new Headers(init.headers);
    if (!headers.get('x-tts-access-token')) return json({ code: 105002, message: 'Missing token' });

    const body = rawBody ? JSON.parse(rawBody) : null;
    world.tiktokCalls.push({ method, path, body });

    // 官方文档里这些接口没有 shop_cipher，其他接口必须带。
    const sellerLevel = SELLER_LEVEL.some((re) => re.test(path));
    if (sellerLevel && url.searchParams.has('shop_cipher')) return json({ code: 106002, message: `${path} 不接受 shop_cipher` });
    if (!sellerLevel && !url.searchParams.has('shop_cipher')) return json({ code: 106003, message: `${path} 缺 shop_cipher` });

    if (path === '/authorization/202309/shops') {
      return ok({ shops: [{ id: 'shop-1', name: '测试店', region: 'JP', cipher: 'cipher-1', seller_type: 'CROSS_BORDER' }] });
    }
    if (path === '/seller/202309/permissions') {
      return ok({ permissions: options.globalPermission ? ['MANAGE_GLOBAL_PRODUCT'] : [] });
    }
    if (path === '/logistics/202309/warehouses') {
      return ok({ warehouses: [
        { id: 'wh-return', type: 'RETURN_WAREHOUSE', effect_status: 'ENABLED', is_default: true },
        { id: 'wh-sales', type: 'SALES_WAREHOUSE', effect_status: options.warehouseStatus ?? 'ENABLED', is_default: true, sub_type: 'CB_DIRECT_SHIPPING_WAREHOUSE' },
      ] });
    }
    if (path === '/logistics/202309/global_warehouses') {
      return ok({ global_warehouses: [{ id: 'gwh-1', name: '义乌仓', ownership: 'SELLER' }] });
    }
    if (path === '/product/202309/images/upload') {
      const form = init.body as FormData;
      if (!form.get('data') || form.get('use_case') !== 'MAIN_IMAGE') return json({ code: 12019001, message: 'bad upload' });
      const uri = `tos-image-${uploaded.size + 1}`;
      uploaded.add(uri);
      return ok({ uri });
    }
    if (path === '/product/202309/categories/recommend' || path === '/product/202309/global_categories/recommend') {
      if (!body.product_title) return json({ code: 12019002, message: 'title required' });
      if (path.includes('global_categories') && 'locale' in body) return json({ code: 12019011, message: '全球类目推荐没有 locale' });
      return ok({
        leaf_category_id: 'cat-3',
        categories: [
          { id: 'cat-1', name: 'Kitchenware', level: 1, is_leaf: false },
          { id: 'cat-2', name: 'Drinkware', level: 2, is_leaf: false },
          { id: 'cat-3', name: 'Water Bottles', level: 3, is_leaf: true },
        ],
      });
    }
    if (path.endsWith('/attributes') || path.endsWith('/global_attributes')) {
      return ok({ attributes: [
        { id: 'a-brand', name: 'ブランド', type: 'PRODUCT_PROPERTY', is_requried: true, is_customizable: true, values: [{ id: 'v-none', name: 'ノーブランド' }] },
        { id: 'a-material', name: '素材', type: 'PRODUCT_PROPERTY', is_requried: false, values: [{ id: 'v-steel', name: 'ステンレス' }] },
        { id: 'a-color', name: 'カラー', type: 'SALES_PROPERTY', is_requried: false, values: [] },
      ] });
    }
    if (path.endsWith('/rules') || path.endsWith('/global_rules')) {
      return ok({ product_certifications: [{ id: 'c-1', name: 'PSE', is_required: false }] });
    }

    const validateProduct = (b: any): string | null => {
      for (const img of b.main_images ?? []) if (!uploaded.has(img.uri)) return `未上传的图片 ${img.uri}`;
      if (!b.main_images?.length) return '缺主图';
      if (b.main_images.length > 9) return '主图超过 9 张';
      if (/[这们说为对]/.test(b.title)) return '标题含中文';
      if (b.package_weight?.unit !== 'GRAM') return '日本站重量单位要用 GRAM';
      for (const s of b.skus) {
        if (!s.seller_sku) return '缺 seller_sku';
      }
      return null;
    };

    if (path === '/product/202309/products/listing_check') {
      const err = validateProduct(body);
      if (err) return json({ code: 12019003, message: err });
      if (options.listingCheckFails) {
        return ok({ check_result: 'FAILED', fail_reasons: [{ code: '1', message: '必填属性缺失：ブランド' }], warnings: [] });
      }
      // 官方文档里 warnings 是对象，不是数组。
      return ok({ check_result: 'PASS', fail_reasons: [], warnings: { message: '建议增加主图' } });
    }
    if (path === '/product/202309/products') {
      if (body.save_mode !== 'LISTING') return json({ code: 12019009, message: 'save_mode 错误' });
      const err = validateProduct(body);
      if (err) return json({ code: 12019003, message: err });
      for (const s of body.skus) {
        if (!s.price?.sale_price) return json({ code: 12019004, message: 'sale_price 必填' });
        if (s.price.currency !== 'JPY') return json({ code: 12019005, message: '币种错误' });
        if (!s.inventory?.[0]?.warehouse_id) return json({ code: 12019006, message: '缺仓库' });
      }
      if (options.tiktokFailsOnCreate) return json({ code: 12019007, message: '平台拒绝' });
      world.created.push(body);
      if (options.createAppliedThen502) return new Response('bad gateway', { status: 502 });
      return ok({ product_id: 'prod-1', skus: body.skus.map((s: any, i: number) => ({ id: `sku-${i + 1}`, seller_sku: s.seller_sku })) });
    }
    if (path === '/product/202309/global_products') {
      const err = validateProduct(body);
      if (err) return json({ code: 12019003, message: err });
      if (body.skus.some((s: any) => s.price.currency !== 'USD')) return json({ code: 12019005, message: '全球商品币种要用 USD' });
      for (const s of body.skus) {
        for (const a of s.sales_attributes) {
          if (!/^[A-Za-z0-9 ]+$/.test(a.value_name)) return json({ code: 12019012, message: `规格值只能是字母和数字：${a.value_name}` });
        }
        if (!s.inventory?.[0]?.global_warehouse_id) return json({ code: 12019013, message: '缺全球仓库' });
      }
      world.created.push(body);
      return ok({ global_product_id: 'gp-1', global_skus: body.skus.map((s: any, i: number) => ({ id: `gsku-${i + 1}`, seller_sku: s.seller_sku })) });
    }
    if (/\/global_products\/.+\/publish$/.test(path)) {
      const target = body.publish_target?.[0];
      if (target?.region !== 'JP' || target.skus.some((s: any) => !s.price.sale_price)) {
        return json({ code: 12019008, message: '发布目标错误' });
      }
      world.created.push(body);
      const status = options.publishStatus ?? 'SUCCESS';
      return ok({
        products: status === 'SUCCESS' ? [{ id: 'prod-g1', region: 'JP' }] : [],
        publish_result: [{ region: 'JP', status, fail_reasons: [] }],
      });
    }
    if (path === '/product/202309/products/deactivate') {
      if (!Array.isArray(body.product_ids) || body.product_ids.length === 0) return json({ code: 12019010, message: '缺商品 ID' });
      return ok({});
    }
    if (path === '/order/202507/orders') {
      if ((options.orderFetchFailures ?? 0) > 0) {
        options.orderFetchFailures!--;
        return json({ code: 40001, message: '订单接口暂时不可用' }, 400);
      }
      return ok({ orders: world.order ? [world.order] : [] });
    }
    return json({ code: 404, message: `未模拟的接口 ${path}` }, 404);
  }

  function claude(init: RequestInit): Response {
    world.claudeCalls++;
    const headers = new Headers(init.headers);
    if (headers.get('anthropic-version') !== '2026-10-21') return json({ error: { message: 'bad version' } }, 400);
    const body = JSON.parse(init.body as string);
    if ('temperature' in body) return json({ error: { message: 'temperature removed' } }, 400);
    assertStrictSchema(body.output_config.format.schema);

    const task = /\[task:(\w+)\]/.exec(body.system)?.[1];
    const content = body.messages[0].content;
    const reply = (data: unknown) => json({ content: [{ type: 'text', text: JSON.stringify(data) }], stop_reason: 'end_turn' });

    switch (task) {
      case 'structure': {
        const input = JSON.parse(content[0].text);
        return reply({
          title: options.sourceTitle ?? '304不锈钢保温杯 500ml',
          description: '双层真空，保温 12 小时。',
          attributes: [{ name: '材质', value: '304不锈钢' }],
          skus: [
            { specs: [{ name: '颜色', value: '蓝色' }], price_cny: options.priceCny ?? 18, image_url: null },
            { specs: [{ name: '颜色', value: '黑色' }], price_cny: (options.priceCny ?? 18) + 3, image_url: null },
          ],
          images: [...input.images, 'https://evil.example/not-on-page.jpg'],
          weight_grams: 320,
          dimensions_cm: { l: 22, w: 8, h: 8 },
          domestic_shipping_cny: null,
        });
      }
      case 'localize': {
        const hasFeedback = Boolean(JSON.parse(content[0].text).feedback);
        const dirty = options.chineseFirstPass && !hasFeedback;
        return reply({
          title: dirty ? '这款ステンレス水筒 500ml' : 'ステンレス水筒 500ml 真空二重構造',
          description_paragraphs: options.descriptionParagraphs ?? ['真空二重構造のステンレス水筒です。', '容量は500mlで、毎日の持ち運びに便利です。'],
          market_query: 'ステンレス 水筒 500ml',
          sales_attributes: [{ source_name: '颜色', name: 'カラー', values: [{ source: '蓝色', ja: 'ブルー', en: 'Blue' }, { source: '黑色', ja: 'ブラック', en: 'Black' }] }],
          estimated_weight_grams: null,
          estimated_dimensions_cm: null,
          risk_flags: [],
        });
      }
      case 'images':
        return reply({ picks: [
          { index: 0, has_chinese_text: true }, { index: 1, has_chinese_text: false },
          { index: 2, has_chinese_text: false }, { index: 3, has_chinese_text: false },
          { index: 4, has_chinese_text: false }, { index: 99, has_chinese_text: false },
        ] });
      case 'category':
        return reply({ category: 'Kitchenware', sub_category: 'none' });
      case 'attributes':
        return reply({ items: [
          { attribute_id: 'a-brand', value_ids: ['v-none'], custom_value: null },
          { attribute_id: 'a-material', value_ids: ['v-invented'], custom_value: null },
          { attribute_id: 'a-invented', value_ids: ['x'], custom_value: 'x' },
        ] });
      case 'comparables': {
        const results = JSON.parse(content[0].text).results as { index: number }[];
        return reply({ same_item_indexes: results.map((r) => r.index) });
      }
      case 'video_caption': {
        const input = JSON.parse(content[content.length - 1].text);
        return reply({
          caption: input.kind === 'shoppable' ? '毎日使える真空ボトル✨ 下のリンクからチェックしてね' : 'みんなはどっち派？コメントで教えて👇',
          hashtags: ['#TikTok売れ筋', '便利グッズ', '便利グッズ', 'fyp'],
          hook: '冷たさが12時間続く？',
        });
      }
      default:
        return json({ error: { message: `未知任务 ${task}` } }, 400);
    }
  }

  function feishu(url: URL, init: RequestInit): Response {
    const path = url.pathname.replace('/open-apis', '');
    if (path === '/auth/v3/tenant_access_token/internal') {
      return json({ code: 0, msg: 'ok', tenant_access_token: 't-token', expire: 7200 });
    }
    if (!new Headers(init.headers).get('authorization')) return json({ code: 99991661, msg: 'no token' });
    if (path === '/im/v1/images') return json({ code: 0, data: { image_key: `img_${Math.random().toString(36).slice(2, 8)}` } });
    if (path === '/im/v1/messages' && init.method === 'POST') {
      const b = JSON.parse(init.body as string);
      const id = `om_${world.feishuMessages.length + 1}`;
      world.feishuMessages.push({ id, chatId: b.receive_id, type: b.msg_type, content: JSON.parse(b.content) });
      return json({ code: 0, data: { message_id: id } });
    }
    const patch = /^\/im\/v1\/messages\/([^/]+)$/.exec(path);
    if (patch && init.method === 'PATCH') {
      world.feishuUpdates.push({ id: patch[1], content: JSON.parse(JSON.parse(init.body as string).content) });
      return json({ code: 0, data: {} });
    }
    if (/\/resources\//.test(path)) return new Response(IMAGE_BYTES, { headers: { 'content-type': 'image/jpeg' } });
    return json({ code: 404, msg: `未模拟 ${path}` });
  }

  const SELLER_LEVEL = [
    /^\/seller\/202309\/permissions$/, /^\/logistics\/202309\/global_warehouses$/, /^\/product\/202309\/images\/upload$/,
    /^\/product\/202309\/global_categories\/recommend$/, /\/global_attributes$/, /\/global_rules$/,
    /^\/product\/202309\/global_products/, /^\/authorization\/202309\/shops$/,
  ];

  world.fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    switch (url.hostname) {
      case 'open-api.tiktokglobalshop.com':
        return tiktok(url, init);
      case 'auth.tiktok-shops.com':
        return json({ code: 0, data: {
          access_token: 'at-1', access_token_expire_in: Math.floor(Date.now() / 1000) + 7 * 86400,
          refresh_token: 'rt-1', refresh_token_expire_in: Math.floor(Date.now() / 1000) + 60 * 86400,
          seller_name: '测试卖家',
        } });
      case 'api.anthropic.com':
        if ((world as any).claudeDown) return json({ error: { message: '模型不可用' } }, 400);
        return claude(init);
      case 'open.feishu.cn':
        return feishu(url, init);
      case 'dashscope.example.aliyuncs.com':
        if (url.pathname.endsWith('image-synthesis')) return json({ output: { task_id: 'task-1', task_status: 'PENDING' } });
        return json({ output: { task_id: 'task-1', task_status: 'SUCCEEDED', image_url: 'https://result.oss-cn-beijing.aliyuncs.com/translated.jpg' } });
      case 'openapi.rakuten.co.jp': {
        const prices = options.marketPrices ?? [];
        return json({ items: prices.slice(0, Math.ceil(prices.length / 2)).map((p, i) => ({ itemName: `水筒 ${i}`, itemPrice: p, postageFlag: 0, itemUrl: `https://item.rakuten.co.jp/${i}` })) });
      }
      case 'shopping.yahooapis.jp': {
        const prices = options.marketPrices ?? [];
        return json({ hits: prices.slice(Math.ceil(prices.length / 2)).map((p, i) => ({ name: `水筒 Y${i}`, price: p, shipping: { code: 2 }, url: `https://store.shopping.yahoo.co.jp/${i}` })) });
      }
      case 'api.frankfurter.dev':
        return json({ rates: { [url.searchParams.get('symbols') ?? 'JPY']: url.searchParams.get('base') === 'USD' ? 150 : 21 } });
      default:
        if (/alicdn\.com$|aliyuncs\.com$/.test(url.hostname)) return new Response(IMAGE_BYTES);
        throw new Error(`未模拟的地址 ${url.hostname}`);
    }
  };

  return world;
}

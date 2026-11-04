// 半自动模式：没有 TikTok 接口时，准备好发布资料，由你手动发布到卖家中心。
// 这里不调用任何 TikTok 接口，也不操作卖家中心页面。
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ListingDraft, SourceProduct } from '../types.ts';
import { chooseCategory } from './llm.ts';
import {
  assertContentSafe, buildSkus, collectImages, localizeChecked, precheck, priceDraft, resolveSize,
  type CollectedImage, type PipelineDeps,
} from './pipeline.ts';
import { overallRisk } from './screen.ts';

export async function buildManualDraft(deps: Omit<PipelineDeps, 'tiktok'>, source: SourceProduct): Promise<{ draft: ListingDraft; images: CollectedImage[] }> {
  const flags = precheck(source);
  const notes: string[] = [];
  const id = randomUUID();

  const content = await localizeChecked(deps, source, notes);
  flags.push(...content.riskFlags);
  assertContentSafe(content);

  const images = await collectImages(deps, source, notes);
  if (images.length === 0) throw new Error('商品图全部处理失败');
  if (images.length < 5) notes.push(`只有 ${images.length} 张主图，官方建议至少 5 张`);

  let categoryPath: string[];
  try {
    categoryPath = await chooseCategory(deps.claude, content, deps.pricing.commission);
  } catch (err) {
    categoryPath = ['未识别'];
    notes.push(`类目判断失败：${(err as Error).message}`);
  }

  const size = resolveSize(source, content, notes);
  const pricing = await priceDraft(deps, source, content, categoryPath, size, notes);
  const prices = new Map(pricing.skus.map((s) => [s.sourceSkuId, s.priceJpy]));

  for (const f of flags) notes.push(`风险：${f.reason}`);

  const draft: ListingDraft = {
    id,
    shopId: 'manual',
    source,
    content,
    images: images.map((i) => ({ uri: '', sourceUrl: i.sourceUrl, previewUrl: i.previewUrl, translated: i.translated })),
    categoryId: '',
    categoryPath,
    attributes: [],
    pricing,
    skus: buildSkus(id, source, content, prices, deps.pricing.inventory.defaultStock),
    weightGrams: size.weightGrams,
    dimensionsCm: size.dimensionsCm,
    warehouseId: '',
    globalWarehouseId: null,
    listingRoute: 'manual',
    check: { passed: true, failReasons: [], warnings: [] },
    notes,
    risk: overallRisk(flags),
    previewImageKeys: [],
    createdAt: Date.now(),
    packageDir: null,
  };
  return { draft, images };
}

/** 可以直接复制到卖家中心的文字。 */
export function copyText(draft: ListingDraft): string {
  return [
    '商品标题',
    draft.content.title,
    '',
    '商品描述',
    ...draft.content.descriptionParagraphs,
  ].join('\n');
}

function imageExtension(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
  if (bytes[0] === 0x52 && bytes[8] === 0x57) return 'webp';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'gif';
  return 'jpg';
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function writeListingFiles(dir: string, draft: ListingDraft) {
  const d = draft.dimensionsCm;
  const lines = [
    copyText(draft),
    '',
    '规格和售价（日元，含税）',
    ...draft.skus.map((s) => `${s.sellerSku}  ${s.specs.map((x) => x.value).join(' / ') || '单规格'}  ¥${s.priceJpy}  库存 ${s.stock}`),
    '',
    `包裹：${draft.weightGrams} 克，${d.l} × ${d.w} × ${d.h} 厘米`,
    `建议类目：${draft.categoryPath.join(' > ')}`,
    `货源：${draft.source.url}`,
  ];
  if (draft.notes.length > 0) lines.push('', '需要注意', ...draft.notes.map((n) => `- ${n}`));
  writeFileSync(join(dir, 'listing.txt'), `${lines.join('\r\n')}\r\n`);

  const header = ['Seller SKU', '规格', '售价（日元）', '库存'];
  const rows = draft.skus.map((s) => [s.sellerSku, s.specs.map((x) => x.value).join(' / '), s.priceJpy, s.stock]);
  // 带 BOM，Excel 才能正确显示中文和日文。
  writeFileSync(join(dir, 'skus.csv'), `﻿${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`);
}

/** 把图片和文字写到一个文件夹，返回文件夹路径。 */
export function writePackage(root: string, draft: ListingDraft, images: CollectedImage[]): string {
  const date = new Date(draft.createdAt).toISOString().slice(0, 10);
  const dir = join(root, `${date}-${draft.id.slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  images.forEach((image, i) => {
    const name = `${String(i + 1).padStart(2, '0')}${image.translated ? '-translated' : ''}.${imageExtension(image.bytes)}`;
    writeFileSync(join(dir, name), image.bytes);
  });
  writeListingFiles(dir, draft);
  return dir;
}

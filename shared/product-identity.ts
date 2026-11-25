/**
 * The OpenMotion repository sets PRODUCT_ID to 'openmotion'.
 * Preserve each repository's value when synchronizing code.
 */
export type ProductId = 'openmotion' | 'opengame';
export const PRODUCT_ID: ProductId = 'opengame' as const;
export const PRODUCT_UTM_SOURCE = PRODUCT_ID;

export function attributedEntryIdFor(product: ProductId, uuid: string): string {
  return product === 'openmotion' ? uuid : `${product}-${uuid}`;
}

export function attributedEntryId(uuid: string): string {
  return attributedEntryIdFor(PRODUCT_ID, uuid);
}

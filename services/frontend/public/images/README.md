# Product photos

Drop 8 JPEGs here, named after each product's **SKU** (which doubles as the
image slug, see `db/init/01-schemas.sql`):

```
tote.jpg  mug.jpg  scarf.jpg  shirt.jpg  belt.jpg  beanie.jpg  throw.jpg  bookend.jpg
```

The storefront renders `/images/<sku>.jpg` and falls back to a labelled
neutral placeholder when the file is missing, so **no code change is needed** —
add the file and it appears.

Square-ish crops work best: the card uses `aspect-ratio: 1/1` with
`object-fit: cover`, so a very wide or very tall photo gets cropped from the
centre rather than letterboxed.

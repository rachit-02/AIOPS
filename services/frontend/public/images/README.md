# Product photos

Drop JPEGs here, named after each product's **SKU** — the SKU doubles as the
image slug (see `db/init/01-schemas.sql`), so the catalogue and the filenames
can never drift apart:

```
tote.jpg           mug.jpg            scarf.jpg          shirt.jpg
belt.jpg           beanie.jpg         candle.jpg         notebook.jpg
plant.jpg          sunglasses.jpg     socks.jpg          bookend.jpg
backpack.jpg       throwblanket.jpg   napkins.jpg        apron.jpg
peacoat.jpg        towels.jpg         cardholder.jpg     pen.jpg
placemats.jpg      sneakers.jpg       campmug.jpg        passport.jpg
```

The storefront renders `/images/<sku>.jpg` and falls back to a neutral panel
labelled with the SKU when the file is missing, so **no code change is needed** —
add the file and it appears. The placeholder is deliberately plain rather than
an illustration: it should read as "a photo belongs here", not as finished art.

Square-ish crops work best: the card uses `aspect-ratio: 1/1` with
`object-fit: cover`, so a very wide or very tall photo gets cropped from the
centre rather than letterboxed. The quick-view modal uses 16/10 and crops the
same photo from the centre.

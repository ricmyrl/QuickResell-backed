INSERT INTO "Category" ("id", "name")
VALUES
    ('category_books', 'Books'),
    ('category_clothing', 'Clothing'),
    ('category_electronics', 'Electronics'),
    ('category_furniture', 'Furniture'),
    ('category_dorm_essentials', 'Dorm Essentials'),
    ('category_sports_outdoors', 'Sports & Outdoors'),
    ('category_other', 'Other')
ON CONFLICT ("name") DO NOTHING;

"""Build the bundled exercise library from the public-domain free-exercise-db dataset.

Source: https://github.com/yuhonas/free-exercise-db (The Unlicense)

Usage:
    python -I tools/build_exercises.py <path-to-free-exercise-db> public/exercises [--sample N]

Writes:
    index.json      one compact record per exercise (everything the lists and the planner need)
    steps.json      id -> how-to steps, loaded only when an exercise is opened
    img/<id>/0.webp, 1.webp   start / end position, resized for phones
    img/<id>/t.webp           square thumbnail for lists

Only needed if you want to regenerate the library; the app ships with the output already built.
"""
import argparse
import json
from pathlib import Path

from PIL import Image

FRAME_MAX_W = 720
FRAME_MAX_H = 720
FRAME_QUALITY = 68
THUMB_SIZE = 168
THUMB_QUALITY = 62

# The dataset's names are kept, except a few that read awkwardly in a list.
RENAMES = {
    "Barbell_Bench_Press_-_Medium_Grip": "Barbell Bench Press",
    "Barbell_Incline_Bench_Press_-_Medium_Grip": "Incline Barbell Bench Press",
    "Pullups": "Pull-Up",
    "Pushups": "Push-Up",
    "Butterfly": "Pec Deck Fly",
    "Hyperextensions_Back_Extensions": "Back Extension",
    "Dips_-_Chest_Version": "Chest Dip",
    "Dips_-_Triceps_Version": "Triceps Dip",
    "Triceps_Pushdown_-_Rope_Attachment": "Rope Triceps Pushdown",
    "Triceps_Pushdown_-_V-Bar_Attachment": "V-Bar Triceps Pushdown",
    "Standing_Calf_Raises": "Standing Calf Raise",
    "Leg_Extensions": "Leg Extension",
    "Lying_Leg_Curls": "Lying Leg Curl",
    "Seated_Cable_Rows": "Seated Cable Row",
    "Hammer_Curls": "Hammer Curl",
    "Crunches": "Crunch",
    "Dumbbell_Flyes": "Dumbbell Fly",
    "Incline_Dumbbell_Flyes": "Incline Dumbbell Fly",
    "Reverse_Flyes": "Reverse Fly",
    "Dumbbell_Lunges": "Dumbbell Lunge",
}

# Extra words people actually type when searching.
ALIASES = {
    "Standing_Military_Press": "overhead press ohp barbell shoulder press",
    "Barbell_Shoulder_Press": "seated overhead press ohp",
    "Romanian_Deadlift": "rdl",
    "Stiff-Legged_Barbell_Deadlift": "stiff leg deadlift sldl",
    "Barbell_Deadlift": "conventional deadlift",
    "Butterfly": "pec deck butterfly machine fly chest fly",
    "Reverse_Machine_Flyes": "reverse pec deck rear delt machine",
    "EZ-Bar_Skullcrusher": "skull crusher lying triceps extension",
    "Lying_Triceps_Press": "skull crusher",
    "Pullups": "pull up pullup chin",
    "Chin-Up": "chin up chinup",
    "Pushups": "push up pushup press up",
    "Wide-Grip_Lat_Pulldown": "lat pull down",
    "Side_Lateral_Raise": "lateral raise side raise dumbbell",
    "Barbell_Squat": "back squat",
    "Front_Barbell_Squat": "front squat",
    "Barbell_Hip_Thrust": "hip thrust glute",
    "Bent_Over_Barbell_Row": "barbell row bent over row",
    "One-Arm_Dumbbell_Row": "single arm dumbbell row",
    "Dumbbell_Bicep_Curl": "biceps curl dumbbell curl",
    "Face_Pull": "rear delt rope",
    "Hyperextensions_Back_Extensions": "hyperextension back extension",
    "Cable_Crossover": "cable fly chest fly",
    "Leg_Press": "sled",
    "Standing_Calf_Raises": "calf raise machine",
    "Air_Bike": "bicycle crunch",
    "Parallel_Bar_Dip": "dips",
    "T-Bar_Row_with_Handle": "t bar row tbar",
    "Split_Squat_with_Dumbbells": "bulgarian split squat",
    "Ab_Roller": "ab wheel rollout",
    "Arnold_Dumbbell_Press": "arnold press",
    "Close-Grip_Barbell_Bench_Press": "close grip bench cgbp",
}

# The lifts most people look for first; shown at the top of the library in this order.
POPULAR = [
    "Barbell_Bench_Press_-_Medium_Grip", "Barbell_Squat", "Barbell_Deadlift", "Standing_Military_Press",
    "Pullups", "Bent_Over_Barbell_Row", "Incline_Dumbbell_Press", "Dumbbell_Bench_Press",
    "Barbell_Incline_Bench_Press_-_Medium_Grip", "Wide-Grip_Lat_Pulldown", "Seated_Cable_Rows",
    "Romanian_Deadlift", "Leg_Press", "Side_Lateral_Raise", "Seated_Dumbbell_Press", "Barbell_Curl",
    "Triceps_Pushdown_-_Rope_Attachment", "Leg_Extensions", "Lying_Leg_Curls", "Standing_Calf_Raises",
    "Face_Pull", "Hammer_Curls", "Dumbbell_Bicep_Curl", "One-Arm_Dumbbell_Row", "Chin-Up", "Pushups",
    "Dips_-_Chest_Version", "Dips_-_Triceps_Version", "Cable_Crossover", "Butterfly", "Dumbbell_Flyes",
    "Incline_Dumbbell_Flyes", "Close-Grip_Barbell_Bench_Press", "EZ-Bar_Skullcrusher",
    "Cable_Rope_Overhead_Triceps_Extension", "Triceps_Pushdown", "Arnold_Dumbbell_Press",
    "Front_Dumbbell_Raise", "Reverse_Flyes", "Reverse_Machine_Flyes", "Upright_Barbell_Row", "Dumbbell_Shrug",
    "Barbell_Shrug", "Preacher_Curl", "Incline_Dumbbell_Curl", "EZ-Bar_Curl", "Concentration_Curls",
    "Front_Barbell_Squat", "Hack_Squat", "Goblet_Squat", "Dumbbell_Lunges", "Barbell_Walking_Lunge",
    "Split_Squat_with_Dumbbells", "Barbell_Hip_Thrust", "Stiff-Legged_Barbell_Deadlift", "Seated_Leg_Curl",
    "Seated_Calf_Raise", "Sumo_Deadlift", "T-Bar_Row_with_Handle", "Straight-Arm_Pulldown", "V-Bar_Pulldown",
    "Hyperextensions_Back_Extensions", "Plank", "Crunches", "Hanging_Leg_Raise", "Cable_Crunch",
    "Russian_Twist", "Ab_Roller", "Air_Bike", "Sit-Up", "Thigh_Abductor", "Thigh_Adductor",
    "Machine_Shoulder_Military_Press", "Machine_Bench_Press", "Smith_Machine_Squat", "Smith_Machine_Bench_Press",
    "Bench_Dips", "Tricep_Dumbbell_Kickback", "Palms-Up_Barbell_Wrist_Curl_Over_A_Bench", "Farmers_Walk",
]


def fit(im, max_w, max_h):
    w, h = im.size
    scale = min(max_w / w, max_h / h, 1.0)
    if scale < 1.0:
        im = im.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
    return im


def square_thumb(im, size):
    w, h = im.size
    side = min(w, h)
    left = (w - side) // 2
    # People stand near the top of portrait shots, so bias the crop upward a little.
    top = (h - side) // 3 if h > w else (h - side) // 2
    return im.crop((left, top, left + side, top + side)).resize((size, size), Image.LANCZOS)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dataset", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--sample", type=int, default=0, help="only convert the first N exercises' images")
    args = ap.parse_args()

    data = json.loads((args.dataset / "dist" / "exercises.json").read_text(encoding="utf-8"))
    known = {e["id"] for e in data}
    for label, ids in (("RENAMES", RENAMES), ("ALIASES", ALIASES), ("POPULAR", POPULAR)):
        missing = [i for i in ids if i not in known]
        if missing:
            raise SystemExit(f"{label} refers to unknown exercise ids: {missing}")

    pop_rank = {ex_id: rank for rank, ex_id in enumerate(POPULAR, start=1)}
    index, steps = [], {}
    total_bytes = 0
    for n, e in enumerate(sorted(data, key=lambda x: x["name"].lower())):
        ex_id = e["id"]
        has_img = len(e["images"]) >= 2
        rec = {
            "id": ex_id,
            "name": RENAMES.get(ex_id, e["name"]),
            "cat": e["category"],
            "eq": e["equipment"] or "none",
            "lvl": e["level"],
            "pm": e["primaryMuscles"],
            "sm": e["secondaryMuscles"],
        }
        if e.get("force"):
            rec["force"] = e["force"]
        if e.get("mechanic"):
            rec["mech"] = e["mechanic"]
        if has_img:
            rec["img"] = 1
        if ex_id in pop_rank:
            rec["pop"] = pop_rank[ex_id]
        if ex_id in ALIASES:
            rec["aka"] = ALIASES[ex_id]
        index.append(rec)
        steps[ex_id] = [s.strip() for s in e["instructions"] if s.strip()]

        if has_img and (not args.sample or n < args.sample):
            dest = args.out / "img" / ex_id
            dest.mkdir(parents=True, exist_ok=True)
            for i, rel in enumerate(e["images"][:2]):
                with Image.open(args.dataset / "exercises" / rel) as im:
                    im = im.convert("RGB")
                    frame = fit(im, FRAME_MAX_W, FRAME_MAX_H)
                    frame.save(dest / f"{i}.webp", "WEBP", quality=FRAME_QUALITY, method=6)
                    total_bytes += (dest / f"{i}.webp").stat().st_size
                    if i == 0:
                        square_thumb(im, THUMB_SIZE).save(dest / "t.webp", "WEBP", quality=THUMB_QUALITY, method=6)
                        total_bytes += (dest / "t.webp").stat().st_size

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (args.out / "steps.json").write_text(json.dumps(steps, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"exercises: {len(index)}  with photos: {sum(1 for r in index if r.get('img'))}")
    print(f"index.json: {(args.out / 'index.json').stat().st_size / 1024:.0f} KB   "
          f"steps.json: {(args.out / 'steps.json').stat().st_size / 1024:.0f} KB   "
          f"images written: {total_bytes / 1024 / 1024:.1f} MB")


if __name__ == "__main__":
    main()

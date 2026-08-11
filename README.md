# ExamPrepper LMS

This folder contains the first complete working build of the Study LMS.

## Files

- `index.html` — UI/screens
- `style.css` — current soft blush responsive styling
- `app.js` — Firebase + profiles + quiz engine + adaptive queue
- `nursing_w1.json` — sample quiz data

## Firebase setup

The app uses your supplied Firebase project configuration and Firestore.

Create these Firestore collections/documents:

### `quizzes/{topicId}`

Upload a quiz through the dashboard, or create it manually.

Example:

```json
{
  "topicId": "tissue_skin",
  "topicName": "Tissue, Skin & Integumentary System",
  "subtopics": [
    {"id":"epithelium","name":"Epithelial Tissue"},
    {"id":"connective","name":"Connective Tissue & Cartilage"}
  ],
  "questions": [
    {
      "id":"ts_q01",
      "subtopicId":"epithelium",
      "question":"Which type of epithelium consists of a single layer of cells?",
      "options":["Simple epithelium","Stratified epithelium","Dense regular connective tissue","Transitional epithelium"],
      "answer":0,
      "explanation":"Simple epithelium consists of a single cell layer."
    }
  ]
}
```

### `profiles/{profileId}`

Created by the app.

Each profile has its own progress:

`profiles/{profileId}/progress/{topicId}`

Question statistics are stored under `questions`.

## Important Firestore security note

The supplied build is intentionally a client-side prototype. Do not deploy it publicly with unrestricted Firestore rules.

For a private/local prototype, configure Firestore rules appropriately for your environment. For a public deployment, add Firebase Authentication or another trusted access layer and lock the rules down.

## Running locally

Because `app.js` uses ES modules and Firebase imports, do not open `index.html` directly with `file://`.

Use a local web server, for example:

```bash
python -m http.server 8000
```

Then open:

`http://localhost:8000/`

Or deploy the folder to Firebase Hosting / another static host.

## First launch\n\nThe profile screen works even when the Firebase `profiles` collection is empty. The `+ Add Profile` card is always shown until 4 profiles exist, so the first user can create a profile and enter the dashboard.\n\n## Profile deletion\n\nManage Profiles includes Rename and Delete. Deleting a profile removes its profile document and its stored per-topic progress documents. Shared quiz documents under `quizzes` are never deleted.\n\n## Current functionality

- Up to 4 profiles
- Independent statistics per profile
- Shared quiz library
- Add/rename/delete profile
- Topic dashboard
- Dynamic subtopic selection
- Select all / deselect all
- Standard quiz
- Adaptive weighted quiz
- Flashcards
- Question timer
- Strict mode
- Question count
- Correct/incorrect tracking
- Mastery after 2 consecutive correct answers
- Flag after 2+ total incorrect answers
- Topic progress
- Study time
- Quiz result review
- JSON quiz import into Firestore


## Profile selector fix

The profile selector now has two dedicated controls below the profile cards:
- `＋ Add Profile`
- `⚙ Manage Profiles`

They are always visible on the profile screen (Add is hidden only after 4 profiles). These controls do not depend on a profile existing or on the Firebase profile collection being populated.

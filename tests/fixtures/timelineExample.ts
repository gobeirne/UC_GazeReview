// Synthetic example from the timeline format specification (no real data).
export const timelineExample = {
  "format": "moodle-quiz-response-timeline/v1",
  "time_basis": "Moodle displayed local time (no timezone offset inferred)",
  "attempt": {
    "quiz_title": "Example Research Methods Quiz: Attempt review (SYNTHETIC)",
    "started": "2026-11-05T09:00:00",
    "finished": "2026-11-05T09:30:00",
    "duration_seconds": 1800,
    "questions_found": 3,
    "questions_with_response_history": 3,
    "questions_with_saves": 3,
    "save_events": 7,
    "changed_answer_events": 2,
    "repeated_same_answer_events": 2
  },
  "events": [
    {
      "time": "2026-11-05T09:02:10",
      "time_display": "5/11/26, 09:02:10",
      "question_number": 1,
      "question_slot": 12,
      "history_step": 2,
      "answer": "The participant selection process",
      "option_letter": "C",
      "question_text": "Which term describes the list of individuals from which a sample is drawn?",
      "save_number": 1,
      "change_type": "first_save",
      "seconds_from_start": 130
    },
    {
      "time": "2026-11-05T09:03:15",
      "time_display": "5/11/26, 09:03:15",
      "question_number": 2,
      "question_slot": 7,
      "history_step": 2,
      "answer": "Random assignment reduces selection bias.",
      "option_letter": null,
      "question_text": "In one or two sentences, explain why random assignment helps establish internal validity.",
      "save_number": 1,
      "change_type": "first_save",
      "seconds_from_start": 195
    },
    {
      "time": "2026-11-05T09:06:20",
      "time_display": "5/11/26, 09:06:20",
      "question_number": 3,
      "question_slot": 22,
      "history_step": 2,
      "answer": "Median",
      "option_letter": "B",
      "question_text": "Which measure of central tendency is the middle value of an ordered dataset?",
      "save_number": 1,
      "change_type": "first_save",
      "seconds_from_start": 380
    },
    {
      "time": "2026-11-05T09:08:05",
      "time_display": "5/11/26, 09:08:05",
      "question_number": 1,
      "question_slot": 12,
      "history_step": 3,
      "answer": "The sampling frame",
      "option_letter": "A",
      "question_text": "Which term describes the list of individuals from which a sample is drawn?",
      "save_number": 2,
      "change_type": "revision",
      "seconds_from_start": 485
    },
    {
      "time": "2026-11-05T09:10:20",
      "time_display": "5/11/26, 09:10:20",
      "question_number": 2,
      "question_slot": 7,
      "history_step": 3,
      "answer": "Random assignment reduces selection bias by tending to make groups comparable at baseline, on average.",
      "option_letter": null,
      "question_text": "In one or two sentences, explain why random assignment helps establish internal validity.",
      "save_number": 2,
      "change_type": "revision",
      "seconds_from_start": 620
    },
    {
      "time": "2026-11-05T09:11:05",
      "time_display": "5/11/26, 09:11:05",
      "question_number": 3,
      "question_slot": 22,
      "history_step": 3,
      "answer": "Median",
      "option_letter": "B",
      "question_text": "Which measure of central tendency is the middle value of an ordered dataset?",
      "save_number": 2,
      "change_type": "resave",
      "seconds_from_start": 665
    },
    {
      "time": "2026-11-05T09:12:30",
      "time_display": "5/11/26, 09:12:30",
      "question_number": 1,
      "question_slot": 12,
      "history_step": 4,
      "answer": "The sampling frame",
      "option_letter": "A",
      "question_text": "Which term describes the list of individuals from which a sample is drawn?",
      "save_number": 3,
      "change_type": "resave",
      "seconds_from_start": 750
    }
  ]
} as const;

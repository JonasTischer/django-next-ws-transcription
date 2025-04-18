from django.db import models

class Transcription(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)
    title = models.CharField(max_length=255)

    def __str__(self):
        return self.title

class TranscriptSegment(models.Model):
    transcription = models.ForeignKey(Transcription, related_name='segments', on_delete=models.CASCADE)
    text = models.TextField()
    speaker = models.CharField(max_length=100, null=True, blank=True)
    start_time = models.FloatField()  # in seconds
    end_time = models.FloatField()  # in seconds
    is_final = models.BooleanField(default=False)

    class Meta:
        ordering = ['start_time']

    def __str__(self):
        return f"{self.speaker}: {self.text[:50]}..."
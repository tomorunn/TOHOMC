from django.urls import path
from django.views.generic import TemplateView
from django.contrib import admin

urlpatterns = [
    path('', TemplateView.as_view(template_name='index.html'), name='home'),
    path('admin/', admin.site.urls),
]
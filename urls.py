from django.urls import path
from django.contrib import admin
from django.views.generic import TemplateView  # 仮にテンプレートを表示

urlpatterns = [
    path('', TemplateView.as_view(template_name='index.html'), name='home'),
    path('admin/', admin.site.urls),
]
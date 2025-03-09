from django.shortcuts import render, redirect
from django.contrib.auth import authenticate, login, logout  # logoutを追加
from django.contrib.auth.models import User
from .models import Problem, Submission
from django.db.models import Count

def index(request):
    problems = Problem.objects.all()
    rankings = Submission.objects.filter(is_correct=True).values('user_name').annotate(correct_count=Count('id')).order_by('-correct_count')
    return render(request, 'contest/index.html', {'problems': problems, 'rankings': rankings})

def submit_answer(request):
    if request.method == 'POST' and request.user.is_authenticated:
        user_name = request.user.username
        problem_id = request.POST['problem_id']
        submitted_answer = request.POST['answer']
        problem = Problem.objects.get(id=problem_id)
        is_correct = (submitted_answer == problem.answer)
        
        Submission.objects.create(
            user_name=user_name,
            problem=problem,
            submitted_answer=submitted_answer,
            is_correct=is_correct
        )
        return render(request, 'contest/submit_success.html')
    return redirect('login')

def user_login(request):
    if request.method == 'POST':
        username = request.POST['username']
        password = request.POST['password']
        user = authenticate(request, username=username, password=password)
        if user is not None:
            login(request, user)
            return redirect('index')
        else:
            return render(request, 'contest/login.html', {'error': 'ユーザー名またはパスワードが正しくありません'})
    return render(request, 'contest/login.html')

def register(request):
    if request.method == 'POST':
        username = request.POST['username']
        password = request.POST['password']
        password_confirm = request.POST['password_confirm']
        if password == password_confirm:
            if User.objects.filter(username=username).exists():
                return render(request, 'contest/register.html', {'error': 'このユーザー名は既に使用されています'})
            else:
                user = User.objects.create_user(username=username, password=password)
                user.save()
                login(request, user)
                return redirect('index')
        else:
            return render(request, 'contest/register.html', {'error': 'パスワードが一致しません'})
    return render(request, 'contest/register.html')

def user_logout(request):
    logout(request)  # ユーザーをログアウト
    return redirect('login')  # ログインページにリダイレクト
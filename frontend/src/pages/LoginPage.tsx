import {
  Alert,
  Anchor,
  Button,
  Container,
  Paper,
  PasswordInput,
  TextInput,
  Title,
} from '@mantine/core'
import { useForm } from '@mantine/form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { login } from '../api/auth'
import { ApiError } from '../api/client'
import { serverUrl, setServerUrl } from '../desktop/connection'
import { isDesktop } from '../desktop/runtime'

// в приложении сбой не от сервера (нет связи, опечатка в адресе, сбой хранилища
// ОС) общим «попробуйте ещё раз» не объяснить — показываем причину
function errorMessage(error: Error): string {
  if (error instanceof ApiError && error.status === 401) return 'Неверный email или пароль'
  // повтор тех же данных бесполезен, поэтому показываем, что сервер в них не принял
  if (error instanceof ApiError && error.status === 422 && error.message !== '') {
    return `Сервер отклонил данные: ${error.message}`
  }
  if (isDesktop() && !(error instanceof ApiError)) {
    return `Не удалось связаться с сервером — проверьте адрес. ${error.message}`
  }
  return 'Не удалось войти, попробуйте ещё раз'
}

export function LoginPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const form = useForm({
    initialValues: { server: isDesktop() ? serverUrl() : '', email: '', password: '' },
    validate: {
      server: (v) => (isDesktop() && v.trim() === '' ? 'Укажите адрес сервера' : null),
      email: (v) => (/^\S+@\S+$/.test(v) ? null : 'Некорректный email'),
      password: (v) => (v.length > 0 ? null : 'Введите пароль'),
    },
  })
  const mutation = useMutation({
    mutationFn: (values: { server: string; email: string; password: string }) => {
      // адрес нужен до запроса: он сам идёт на этот сервер
      if (isDesktop()) setServerUrl(values.server)
      return login(values.email, values.password)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['me'] })
      navigate('/')
    },
  })

  return (
    <Container size={420} my={80}>
      <Title ta="center">AIccountant</Title>
      <Paper withBorder shadow="sm" p="lg" mt="lg" radius="md">
        <form onSubmit={form.onSubmit((values) => mutation.mutate(values))}>
          {isDesktop() && (
            <TextInput label="Адрес сервера" mb="md" {...form.getInputProps('server')} />
          )}
          <TextInput label="Email" placeholder="you@example.com" {...form.getInputProps('email')} />
          <PasswordInput label="Пароль" mt="md" {...form.getInputProps('password')} />
          {mutation.isError && (
            <Alert color="red" mt="md">
              {errorMessage(mutation.error)}
            </Alert>
          )}
          <Button type="submit" fullWidth mt="xl" loading={mutation.isPending}>
            Войти
          </Button>
        </form>
        <Anchor component={Link} to="/register" size="sm" mt="md" display="block" ta="center">
          Нет аккаунта? Зарегистрироваться
        </Anchor>
      </Paper>
    </Container>
  )
}
